import { Effect } from "effect";

import { readBounded } from "../bytes.js";
import { io } from "../effect.js";
import { ModelInputMissing, ModelInputTooLarge } from "../errors.js";

const MODEL_INPUT_LIMIT = 4 * 1024 * 1024;
/** Bound the stream before parsing or cloning it across a Service Binding. */
export const readModelBodyEffect = (request: Request) =>
  Effect.gen(function* () {
    if (!request.body) return yield* new ModelInputMissing();
    const read = yield* io("model.body.read", () => readBounded(request.body, MODEL_INPUT_LIMIT));
    if (read.overflow) return yield* new ModelInputTooLarge();
    return read.bytes;
  });
