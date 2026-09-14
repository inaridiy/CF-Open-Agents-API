import { Effect } from "effect";
import type { FileObject } from "openai/resources/files";
import { z } from "zod";

import { attempt, io } from "./effect.js";
import { ApiError, identifier, parse } from "./protocol.js";

export const INPUT_FILE_LIMIT = 50 * 1024 * 1024;
/** `FilePurpose` of openai@7.15.0; every value is accepted and stored as opaque metadata. */
export const FILE_PURPOSES = [
  "assistants",
  "batch",
  "fine-tune",
  "vision",
  "user_data",
  "evals",
] as const;
export interface StoredInputFile {
  version: 1;
  key: string;
  resource: FileObject;
}
export interface ResolvedInputFile {
  key: string;
  size: number;
}

/** Files API uploads used by Agents environment file_id inputs. */
export function uploadInputFile(bucket: R2Bucket, form: FormData) {
  return Effect.gen(function* () {
    const file = form.get("file");
    if (!(file instanceof File))
      return yield* new ApiError(400, "invalid_file", "Expected a multipart file");
    const purpose = yield* attempt("file.purpose", () =>
      parse(z.enum(FILE_PURPOSES), form.get("purpose")),
    );
    if (file.size > INPUT_FILE_LIMIT)
      return yield* new ApiError(413, "file_too_large", "Environment input files exceed 50 MiB");
    const expires = form.get("expires_after[seconds]");
    const lifetime =
      expires === null
        ? undefined
        : yield* attempt("file.expiry", () =>
            parse(z.coerce.number().int().min(3600).max(2592000), expires),
          );
    if (lifetime !== undefined)
      yield* attempt("file.anchor", () =>
        parse(z.literal("created_at"), form.get("expires_after[anchor]")),
      );
    const id = identifier("file");
    const created_at = Math.floor(Date.now() / 1000);
    const record: StoredInputFile = {
      version: 1,
      key: `input-files/${id}`,
      resource: {
        id,
        object: "file",
        bytes: file.size,
        created_at,
        filename: file.name,
        // `evals` is a valid upload purpose the SDK's FileObject type does not list yet.
        purpose: purpose as FileObject["purpose"],
        status: "processed",
        ...(lifetime ? { expires_at: created_at + lifetime } : {}),
      },
    };
    // The catalog record names this object once it is stored: observe the put's outcome.
    yield* Effect.uninterruptible(
      io("file.store", () =>
        bucket.put(record.key, file.stream(), {
          httpMetadata: { contentType: file.type || "application/octet-stream" },
        }),
      ),
    );
    return record;
  });
}

/**
 * A failed or interrupted R2 write interrupts the producer as well. R2 requires a known
 * length. Interrupting the transfer aborts the copy; the store then observes the broken
 * stream and settles on its own, so an interrupted put is never left with an unknown outcome.
 */
export function copyKnownLength(
  source: ReadableStream<Uint8Array>,
  length: number,
  store: (stream: ReadableStream<Uint8Array>) => PromiseLike<unknown>,
) {
  return Effect.acquireUseRelease(
    attempt("file.transfer.create", () => new FixedLengthStream(length)),
    (stream) =>
      Effect.all(
        [
          io("file.transfer.copy", (signal) => source.pipeTo(stream.writable, { signal })),
          Effect.uninterruptible(io("file.transfer.store", () => store(stream.readable))),
        ],
        { concurrency: 2, discard: true },
      ),
    (stream) =>
      Effect.all(
        [
          io("file.transfer.release_source", () =>
            source.locked ? Promise.resolve() : source.cancel(),
          ).pipe(Effect.ignore),
          io("file.transfer.release_sink", () =>
            stream.readable.locked ? Promise.resolve() : stream.readable.cancel(),
          ).pipe(Effect.ignore),
        ],
        { concurrency: 2, discard: true },
      ),
  );
}
