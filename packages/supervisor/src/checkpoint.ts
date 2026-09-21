import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { io, type ServiceError } from "cf-open-agents-api";
import { Data, Effect, Schema } from "effect";

import { Buffer } from "./buffer.js";

const bundleSchema = Schema.Struct({
  version: Schema.Literal(1),
  threadId: Schema.String,
  files: Schema.Record({ key: Schema.String, value: Schema.String }),
});
export type NativeBundle = typeof bundleSchema.Type;
const MAX_BYTES = 32 * 1024 * 1024;
/** The native home exceeds the checkpoint budget; `path` names the file that crossed it. */
export class CheckpointTooLarge extends Data.TaggedError("CheckpointTooLarge")<{
  readonly path?: string;
}> {
  override get message(): string {
    return this.path
      ? `Native checkpoint exceeds 32 MiB at ${this.path}`
      : "Native checkpoint exceeds 32 MiB";
  }
}
/** A bundle entry would escape or alias the native home. */
export class InvalidCheckpointPath extends Data.TaggedError("InvalidCheckpointPath")<{
  readonly path: string;
}> {
  override get message(): string {
    return "Invalid checkpoint path";
  }
}
/** The bundle handed to `restore` is not one `capture` produced. */
export class InvalidCheckpoint extends Data.TaggedError("InvalidCheckpoint")<{
  readonly issues: string;
}> {
  override get message(): string {
    return `Invalid native checkpoint: ${this.issues}`;
  }
}
export type CheckpointError =
  | ServiceError
  | CheckpointTooLarge
  | InvalidCheckpointPath
  | InvalidCheckpoint;
const list = (path: string) => io("checkpoint.list", () => readdir(path, { withFileTypes: true }));
const read = (path: string) => io("checkpoint.read", () => readFile(path));
const write = (path: string, data: Uint8Array) =>
  Effect.gen(function* () {
    yield* io("checkpoint.mkdir", () => mkdir(join(path, ".."), { recursive: true }));
    yield* io("checkpoint.write", () => writeFile(path, data, { mode: 0o600 }));
  });
const excluded = new Set([
  "config.toml",
  "environments.toml",
  "auth.json",
  "logs",
  "log",
  "tmp",
  "cache",
  ".npm",
  ".cache",
  "node_modules",
]);

/** Call after the native runtime exits, so SQLite/WAL files are quiescent. */
export function capture(
  home: string,
  threadId: string,
): Effect.Effect<NativeBundle, CheckpointTooLarge | ServiceError> {
  return Effect.gen(function* () {
    // The walk owns this accumulator for its whole run: one fiber, no sharing, and
    // an entry costs one insertion rather than a copy of every entry before it.
    const captured = new Map<string, string>();
    let bytes = 0;
    const visit = (relative: string): Effect.Effect<void, CheckpointTooLarge | ServiceError> =>
      Effect.gen(function* () {
        for (const entry of yield* list(join(home, relative))) {
          if (excluded.has(entry.name)) continue;
          const path = relative ? `${relative}/${entry.name}` : entry.name;
          if (entry.isDirectory()) yield* visit(path);
          else if (entry.isFile()) {
            const data = yield* read(join(home, path));
            bytes += data.length;
            if (bytes > MAX_BYTES) return yield* new CheckpointTooLarge({ path });
            captured.set(path, Buffer.from(data).toString("base64"));
          }
        }
      });
    yield* visit("");
    return { version: 1 as const, threadId, files: Object.fromEntries(captured) };
  });
}

export function restore(home: string, value: unknown): Effect.Effect<string, CheckpointError> {
  return Effect.gen(function* () {
    const invalid = (error: { readonly message: string }) =>
      new InvalidCheckpoint({ issues: error.message });
    const bundle = yield* Schema.decodeUnknown(bundleSchema, { onExcessProperty: "error" })(
      value,
    ).pipe(Effect.mapError(invalid));
    // Decode and validate every entry before the first filesystem write.
    let bytes = 0;
    const entries = yield* Effect.forEach(Object.entries(bundle.files), ([path, encoded]) =>
      Effect.gen(function* () {
        if (
          path.startsWith("/") ||
          path.includes("\\") ||
          path.includes("\0") ||
          path.split("/").some((part) => !part || part === "." || part === "..")
        )
          return yield* new InvalidCheckpointPath({ path });
        const data = yield* Schema.decodeUnknown(Schema.Uint8ArrayFromBase64)(encoded).pipe(
          Effect.mapError(invalid),
        );
        bytes += data.byteLength;
        if (bytes > MAX_BYTES) return yield* new CheckpointTooLarge({});
        return { path, data };
      }),
    );
    yield* Effect.forEach(entries, ({ path, data }) => write(join(home, path), data), {
      discard: true,
    });
    return bundle.threadId;
  });
}
