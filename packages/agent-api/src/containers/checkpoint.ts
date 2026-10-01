import { Effect } from "effect";

import { sha256Hex } from "../bytes.js";
import { io } from "../effect.js";
import {
  ArtifactLimitExceeded,
  ArtifactListFailed,
  CheckpointIncompatible,
  CheckpointMissing,
  CheckpointTooLarge,
  Superseded,
  TransportFailure,
} from "../errors.js";
import { HARNESSES } from "../harnesses.js";
import type { Checkpoint, Execution } from "../runtime.js";
import { superseded } from "./assignment.js";
import { assignment, HarnessBindings, type HarnessHost, read, releaseBody, write } from "./host.js";
import { rememberSandbox, sandboxOf, workspaceOf } from "./workspace.js";

const ARTIFACT_FILE_LIMIT = 200 * 1024 * 1024;
/** The serialized native checkpoint the Worker buffers: the supervisor caps contents at 32 MiB. */
const CHECKPOINT_LIMIT = 64 * 1024 * 1024;

/** The stream's bytes, or `undefined` (and the stream cancelled) once it passes `limit`. */
async function readBounded(
  body: ReadableStream<Uint8Array>,
  limit: number,
): Promise<Uint8Array | undefined> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
const ARTIFACT_TURN_LIMIT = 500 * 1024 * 1024;
/**
 * Publish `/workspace/outputs` to R2 under a durable manifest: the manifest is committed
 * before any upload, so a retry uploads the same ids, and uploads that already exist are
 * skipped. Four files transfer at a time; each copy handles its own interruption.
 */
const publishArtifacts = Effect.fn("harness.artifacts")(function* (execution: Execution) {
  const env = yield* HarnessBindings;
  const sandbox = sandboxOf(env, execution.sessionId);
  if (!(yield* io("artifact.exists", () => sandbox.exists("/workspace/outputs")))) return [];
  let manifest = yield* read((tx) => tx.artifacts(execution.generation));
  if (!manifest) {
    const listing = yield* io("artifact.list", () => sandbox.list("/workspace/outputs")).pipe(
      Effect.mapError(() => new ArtifactListFailed()),
    );
    const files = listing
      .filter((file) => file.type === "file")
      .map((file) => ({ absolutePath: file.path, size: file.size }));
    if (
      files.some((file) => file.size > ARTIFACT_FILE_LIMIT) ||
      files.reduce((sum, file) => sum + file.size, 0) > ARTIFACT_TURN_LIMIT
    )
      return yield* new ArtifactLimitExceeded();
    const created_at = Math.floor(Date.now() / 1000);
    manifest = yield* Effect.forEach(files, (file) =>
      Effect.map(
        io("artifact.hash", () => sha256Hex(`${execution.turnId}\0${file.absolutePath}`)),
        (hash) => {
          const id = `artifact_${hash}`;
          return {
            id,
            key: `artifacts/${execution.sessionId}/${id}`,
            path: file.absolutePath,
            size_bytes: file.size,
            session_id: execution.sessionId,
            environment_id: execution.environmentId ?? "",
            turn_id: execution.turnId,
            created_at,
          };
        },
      ),
    );
    const built = manifest;
    yield* write((tx) => tx.putArtifacts(execution.generation, built));
  }
  yield* Effect.forEach(
    manifest,
    (artifact) =>
      Effect.gen(function* () {
        if (yield* io("artifact.head", () => env.CHECKPOINTS.head(artifact.key))) return;
        // The object names this upload in the committed manifest: observe its outcome.
        yield* Effect.uninterruptible(
          io("artifact.copy", () =>
            sandbox.copyToObject(artifact.path, artifact.key, artifact.size_bytes),
          ),
        );
      }),
    { concurrency: 4, discard: true },
  );
  return manifest;
});

/** The native checkpoint document from R2, or nothing for a first turn. */
export function loadCheckpoint(previousCheckpoint: Checkpoint | null) {
  return Effect.gen(function* () {
    const env = yield* HarnessBindings;
    if (!previousCheckpoint) return;
    const object = yield* io("startAttempt", () => env.CHECKPOINTS.get(previousCheckpoint.native));
    if (!object) return yield* new CheckpointMissing({ key: previousCheckpoint.native });
    if (object.size > CHECKPOINT_LIMIT) {
      yield* io("startAttempt.release", () => object.body.cancel()).pipe(Effect.ignore);
      return yield* new CheckpointTooLarge();
    }
    return yield* io("startAttempt", () => object.json());
  });
}
export function snapshot(host: HarnessHost, execution: Execution) {
  return Effect.gen(function* () {
    const current = yield* assignment;
    if (superseded(current, execution))
      return yield* new Superseded({
        turnId: execution.turnId,
        generation: execution.generation,
      });
    if (current.parent)
      return yield* new CheckpointIncompatible({
        message: "Delegated children are not checkpointed",
      });
    const key = `sessions/${execution.sessionId}/${execution.generation}/native.json`;
    const committed = yield* read((tx) => tx.checkpoint(execution.generation));
    if (committed) return committed;
    const response = yield* io("snapshot", (signal) =>
      host.containerFetch(`http://harness/jobs/${execution.turnId}/checkpoint`, { signal }),
    );
    if (!response.ok || !response.body) {
      yield* io("snapshot.release", () => releaseBody(response)).pipe(Effect.ignore);
      return yield* new TransportFailure({
        operation: "snapshot",
        cause: `Native checkpoint failed (${response.status})`,
      });
    }
    // containerFetch may return a chunked stream; R2 requires a known length.
    const body = response.body as ReadableStream<Uint8Array>;
    const bytes = yield* io("snapshot", () => readBounded(body, CHECKPOINT_LIMIT));
    if (!bytes) return yield* new CheckpointTooLarge();
    // The checkpoint record below names this object: its outcome must be observed.
    yield* Effect.uninterruptible(io("snapshot", () => host.env.CHECKPOINTS.put(key, bytes)));
    const workspace = execution.sandbox
      ? yield* io("snapshot", () => sandboxOf(host.env, execution.sessionId).backup())
      : undefined;
    // The live filesystem now equals the committed workspace; the next turn may continue in it.
    if (workspace)
      yield* rememberSandbox(workspaceOf(host.env, execution.sessionId), {
        workspaceId: workspace.id,
        provisioned: true,
      }).pipe(Effect.catchAll(() => write((tx) => tx.forgetSandbox())));
    const artifacts =
      execution.sandbox && execution.environmentId ? yield* publishArtifacts(execution) : [];
    const checkpoint: Checkpoint = {
      version: 1,
      driver: current.harness,
      revision: HARNESSES[current.harness].revision,
      native: key,
      ...(workspace ? { workspace } : {}),
      artifacts,
      environmentFileVersion: host.environment.fileVersion(),
    };
    yield* write((tx) => tx.putCheckpoint(execution.generation, checkpoint));
    return checkpoint;
  });
}
