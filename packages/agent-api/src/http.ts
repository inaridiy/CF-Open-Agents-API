import { Effect } from "effect";

import { io } from "./effect.js";
import { UpstreamRedirect } from "./errors.js";

/** Workers supports manual redirects. Never forward configured credentials to a redirect target. */
export function requestWithoutRedirect(
  operation: string,
  request: Request,
  send: (request: Request) => Promise<Response> = fetch,
) {
  return Effect.gen(function* () {
    const response = yield* io(operation, (signal) =>
      send(
        new Request(request, {
          redirect: "manual",
          signal: AbortSignal.any([request.signal, signal]),
        }),
      ),
    );
    if (response.status >= 300 && response.status < 400) {
      yield* io(`${operation}.discard`, () => response.body?.cancel() ?? Promise.resolve());
      return yield* new UpstreamRedirect({ operation });
    }
    return response;
  });
}
