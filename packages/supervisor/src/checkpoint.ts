import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { decodeEffect, io, runPromise } from "cf-open-agents-api";
import { Context, Effect, Layer, Ref, Schema } from "effect";

const bundleSchema = Schema.Struct({
  version: Schema.Literal(1),
  threadId: Schema.String,
  files: Schema.Record({ key: Schema.String, value: Schema.String }),
});
export type NativeBundle = typeof bundleSchema.Type;
const MAX_BYTES = 32 * 1024 * 1024;
class CheckpointFiles extends Context.Tag("supervisor/CheckpointFiles")<
  CheckpointFiles,
  {
    readonly list: (path: string) => ReturnType<typeof list>;
    readonly read: (path: string) => ReturnType<typeof read>;
    readonly write: (path: string, data: Uint8Array) => ReturnType<typeof write>;
  }
>() {}
const list = (path: string) => io("checkpoint.list", () => readdir(path, { withFileTypes: true }));
const read = (path: string) => io("checkpoint.read", () => readFile(path));
const write = (path: string, data: Uint8Array) =>
  Effect.gen(function* () {
    yield* io("checkpoint.mkdir", () => mkdir(join(path, ".."), { recursive: true }));
    yield* io("checkpoint.write", () => writeFile(path, data, { mode: 0o600 }));
  });
const files = Layer.succeed(CheckpointFiles, { list, read, write });
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
export function capture(home: string, threadId: string): Promise<NativeBundle> {
  const program = Effect.gen(function* () {
    const fs = yield* CheckpointFiles;
    const state = yield* Ref.make({ bytes: 0, files: {} as Record<string, string> });
    const visit = (relative: string): Effect.Effect<void, Error> =>
      Effect.gen(function* () {
        for (const entry of yield* fs.list(join(home, relative))) {
          if (excluded.has(entry.name)) continue;
          const path = relative ? `${relative}/${entry.name}` : entry.name;
          if (entry.isDirectory()) yield* visit(path);
          else if (entry.isFile()) {
            const data = yield* fs.read(join(home, path));
            const current = yield* Ref.get(state);
            const bytes = current.bytes + data.length;
            if (bytes > MAX_BYTES)
              return yield* Effect.fail(new Error(`Native checkpoint exceeds 32 MiB at ${path}`));
            yield* Ref.set(state, {
              bytes,
              files: { ...current.files, [path]: Buffer.from(data).toString("base64") },
            });
          }
        }
      });
    yield* visit("");
    return { version: 1 as const, threadId, files: (yield* Ref.get(state)).files };
  });
  return runPromise(program.pipe(Effect.provide(files)));
}

export function restore(home: string, value: unknown): Promise<string> {
  return runPromise(
    Effect.gen(function* () {
      const fs = yield* CheckpointFiles;
      const bundle = yield* decodeEffect(bundleSchema, value);
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
            return yield* Effect.fail(new Error("Invalid checkpoint path"));
          const data = yield* Schema.decodeUnknown(Schema.Uint8ArrayFromBase64)(encoded);
          bytes += data.byteLength;
          if (bytes > MAX_BYTES)
            return yield* Effect.fail(new Error("Native checkpoint exceeds 32 MiB"));
          return { path, data };
        }),
      );
      yield* Effect.forEach(entries, ({ path, data }) => fs.write(join(home, path), data), {
        discard: true,
      });
      return bundle.threadId;
    }).pipe(Effect.provide(files)),
  );
}
