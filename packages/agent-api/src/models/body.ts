import { Effect } from "effect";

import { io, runPromise } from "../effect.js";
import { ApiError } from "../protocol.js";

/** Bound the stream before parsing or cloning it across a Service Binding. */
export const readModelBodyEffect = (request: Request) =>
  Effect.scoped(
    Effect.gen(function* () {
      const body = request.body;
      if (!body) return yield* new ApiError(400, "missing_model_input", "Model input is required");
      const reader = yield* Effect.acquireRelease(
        Effect.sync(() => body.getReader()),
        (acquired) =>
          io("model.body.close", async () => {
            try {
              await acquired.cancel();
            } finally {
              acquired.releaseLock();
            }
          }).pipe(Effect.orDie),
      );
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const next = yield* io("model.body.read", () => reader.read());
        if (next.done) break;
        const value = next.value as Uint8Array;
        size += value.byteLength;
        if (size > 4 * 1024 * 1024)
          return yield* new ApiError(413, "model_input_too_large", "Model input exceeds 4 MiB");
        chunks.push(value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return bytes;
    }),
  );
export const readModelBody = (request: Request): Promise<Uint8Array<ArrayBuffer>> =>
  runPromise(readModelBodyEffect(request));
