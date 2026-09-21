import { Effect } from "effect";

import { io } from "./effect.js";
import { UpstreamRedirect } from "./errors.js";

/**
 * Whether the answer is a redirect, discarding its body when it is. Two boundaries refuse
 * a redirect and they answer differently: an Effect caller fails with `UpstreamRedirect`,
 * while the gateway's `fetch` wrapper must hand the SDK a Response. Only the decision and
 * the body's disposal are shared.
 */
export async function isRedirect(response: Response): Promise<boolean> {
  if (response.status < 300 || response.status >= 400) return false;
  await response.body?.cancel().catch(() => {});
  return true;
}
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
    if (yield* io(`${operation}.redirect`, () => isRedirect(response)))
      return yield* new UpstreamRedirect({ operation });
    return response;
  });
}
