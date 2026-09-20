import { getSandbox } from "@cloudflare/sandbox";
import { Effect } from "effect";

import { io } from "../effect.js";
import {
  ArtifactLimitExceeded,
  ArtifactListFailed,
  CheckpointIncompatible,
  CheckpointMissing,
  Superseded,
  TransportFailure,
} from "../errors.js";
import { copyKnownLength } from "../files.js";
import { HARNESSES } from "../harnesses.js";
import type { Checkpoint, Execution } from "../runtime.js";
import { superseded } from "./assignment.js";
import { assignment, HarnessBindings, type HarnessHost, read, write } from "./host.js";
import { rememberSandbox } from "./sandbox.js";

const ARTIFACT_FILE_LIMIT = 200 * 1024 * 1024;
const ARTIFACT_TURN_LIMIT = 500 * 1024 * 1024;
/**
 * Publish `/workspace/outputs` to R2 under a durable manifest: the manifest is committed
 * before any upload, so a retry uploads the same ids, and uploads that already exist are
 * skipped. Four files transfer at a time; each copy handles its own interruption.
 */
const publishArtifacts = Effect.fn("harness.artifacts")(function* (execution: Execution) {
  const env = yield* HarnessBindings;
  const sandbox = getSandbox(env.SANDBOX, execution.sessionId);
  if (!(yield* io("artifact.exists", () => sandbox.exists("/workspace/outputs"))).exists) return [];
  let manifest = yield* read((tx) => tx.artifacts(execution.generation));
  if (!manifest) {
    const listing = yield* io("artifact.list", () =>
      sandbox.listFiles("/workspace/outputs", { recursive: true, includeHidden: true }),
    );
    if (!listing.success) return yield* new ArtifactListFailed();
    const files = listing.files.filter((file) => file.type === "file");
    if (
      files.some((file) => file.size > ARTIFACT_FILE_LIMIT) ||
      files.reduce((sum, file) => sum + file.size, 0) > ARTIFACT_TURN_LIMIT
    )
      return yield* new ArtifactLimitExceeded();
    const created_at = Math.floor(Date.now() / 1000);
    manifest = yield* Effect.forEach(files, (file) =>
      Effect.map(
        io("artifact.hash", () =>
          crypto.subtle.digest(
            "SHA-256",
            new TextEncoder().encode(`${execution.turnId}\0${file.absolutePath}`),
          ),
        ),
        (hash) => {
          const id = `artifact_${Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
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
        const source = yield* io("artifact.read", () =>
          sandbox.readFile(artifact.path, { encoding: "none" }),
        );
        yield* copyKnownLength(source.content, artifact.size_bytes, (stream) =>
          env.CHECKPOINTS.put(artifact.key, stream, {
            httpMetadata: { contentType: "application/octet-stream" },
          }),
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
    if (!response.ok || !response.body)
      return yield* new TransportFailure({
        operation: "snapshot",
        cause: `Native checkpoint failed (${response.status})`,
      });
    // containerFetch may return a chunked stream; R2 requires a known length.
    const bytes = yield* io("snapshot", () => response.arrayBuffer());
    // The checkpoint record below names this object: its outcome must be observed.
    yield* Effect.uninterruptible(io("snapshot", () => host.env.CHECKPOINTS.put(key, bytes)));
    const sandbox = getSandbox(host.env.SANDBOX, execution.sessionId);
    const workspace = execution.sandbox
      ? yield* io("snapshot", () =>
          sandbox.createBackup({
            dir: "/workspace",
            localBucket: host.env.LOCAL_BACKUPS === "true",
            ttl: 30 * 24 * 60 * 60,
          }),
        )
      : undefined;
    // The live filesystem now equals the committed workspace; the next turn may continue in it.
    if (workspace)
      yield* rememberSandbox(sandbox, { workspaceId: workspace.id, provisioned: true }).pipe(
        Effect.catchAll(() => write((tx) => tx.forgetSandbox())),
      );
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
