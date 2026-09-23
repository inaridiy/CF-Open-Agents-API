import { Context, Effect, Layer } from "effect";

import { readBounded } from "../bytes.js";
import { attempt, causeChain, io, runPromise, type ServiceError } from "../effect.js";
import {
  ModelNotFound,
  ModelProtocolMismatch,
  ModelUpstreamRejected,
  projectApiError,
} from "../errors.js";
import { isRedirect, requestWithoutRedirect } from "../http.js";
import { readModelBodyEffect } from "./body.js";

/** A single model request. The native harness owns the agent loop and its tools. */
export interface ModelAdapter {
  fetch(request: Request): Promise<Response>;
}

export interface EffectModelAdapter extends ModelAdapter {
  readonly effect: (request: Request) => Effect.Effect<Response, ServiceError>;
}
export const modelAdapter = (effect: EffectModelAdapter["effect"]): EffectModelAdapter => ({
  effect,
  // lint: entrypoint
  fetch: (request) => runPromise(effect(request)),
});

/** A fetch that never follows redirects, so configured credentials stay with the configured host. */
export function fetchWithoutRedirect(
  send: typeof globalThis.fetch = fetch,
): typeof globalThis.fetch {
  return async (input, init) => {
    const response = await send(input, { ...init, redirect: "manual" });
    if (await isRedirect(response)) {
      return Response.json(
        {
          error: { type: "upstream_redirect", message: "Configured upstream returned a redirect" },
        },
        { status: 503 },
      );
    }
    return response;
  };
}

const PROVIDER_ERROR_LIMIT = 64 * 1024;
const SECRET_PATTERN = /\b[A-Za-z]{1,8}-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._-]{8,}/g;
/**
 * Provider error bodies can echo request headers, including masked keys. Keep the
 * status, the structured error fields and Retry-After; drop everything else.
 */
export async function sanitizeProviderError(response: Response): Promise<Response> {
  const { bytes } = await readBounded(response.body, PROVIDER_ERROR_LIMIT);
  const text = new TextDecoder().decode(bytes);
  let error: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object") {
      const inner = (parsed as { error?: unknown }).error;
      error =
        inner && typeof inner === "object"
          ? (inner as Record<string, unknown>)
          : (parsed as Record<string, unknown>);
    }
  } catch {
    error = {};
  }
  const mask = (value: unknown) =>
    typeof value === "string" ? value.replace(SECRET_PATTERN, "[redacted]").slice(0, 2_000) : null;
  const headers = new Headers({ "content-type": "application/json" });
  const retry = response.headers.get("retry-after");
  if (retry) headers.set("retry-after", retry);
  return Response.json(
    {
      error: {
        type: mask(error.type) ?? "upstream_error",
        code: mask(error.code),
        message: mask(error.message) ?? `Upstream model request failed (${response.status})`,
      },
    },
    { status: response.status, headers },
  );
}

/** Preserve provider-native reasoning, custom tools and other protocol extensions. */
export function nativeModel(options: {
  protocol: "responses" | "anthropic" | "chat-completions";
  baseURL: string;
  apiKey: string;
  model: string;
  fetch?: typeof globalThis.fetch;
}): EffectModelAdapter {
  if (!options.apiKey?.trim() || !options.model?.trim())
    throw new Error("A model and API key are required");
  const paths = {
    responses: "/responses",
    anthropic: "/messages",
    "chat-completions": "/chat/completions",
  };
  const base = new URL(options.baseURL.endsWith("/") ? options.baseURL : `${options.baseURL}/`);
  if (base.username || base.password || !["https:", "http:"].includes(base.protocol))
    throw new Error("Invalid model base URL");
  return modelAdapter((request) =>
    Effect.gen(function* () {
      const path = new URL(request.url).pathname.replace(/^\/v1/, "");
      if (path !== paths[options.protocol])
        return yield* new ModelProtocolMismatch({ protocol: options.protocol });
      const body = yield* io("model.body", () => request.json<Record<string, unknown>>());
      const headers = new Headers({ "content-type": "application/json" });
      if (options.protocol === "anthropic") {
        headers.set("x-api-key", options.apiKey);
        headers.set("anthropic-version", request.headers.get("anthropic-version") ?? "2023-06-01");
        const beta = request.headers.get("anthropic-beta");
        if (beta) headers.set("anthropic-beta", beta);
      } else headers.set("authorization", `Bearer ${options.apiKey}`);
      const response = yield* requestWithoutRedirect(
        "model.fetch",
        new Request(new URL(path.slice(1), base), {
          method: "POST",
          headers,
          body: JSON.stringify({ ...body, model: options.model }),
          signal: request.signal,
        }),
        options.fetch,
      );
      if (response.ok) return response;
      return yield* io("model.error", () => sanitizeProviderError(response));
    }),
  );
}

/** The gateway's own envelope: the projected status and message of a definite failure. */
function gatewayFailure(error: ServiceError): Response {
  const definite =
    error._tag !== "OperationError" &&
    error._tag !== "TransportFailure" &&
    error._tag !== "StorageFailure";
  const known = definite ? projectApiError(error) : undefined;
  return Response.json(
    {
      error: {
        type: "model_gateway_error",
        message: known ? known.message : "Invalid or unsupported model request",
      },
    },
    { status: known ? known.status : 400 },
  );
}
/** A registered model: an adapter, or a factory called only when that name is selected. */
export type ModelRegistration = ModelAdapter | (() => ModelAdapter);

/** An answer no model produced output for; the next candidate may do better. */
const rejected = (response: Response) => response.status === 429 || response.status >= 500;
const describeOutcome = (outcome: ServiceError | Response) =>
  outcome instanceof Response ? `HTTP ${outcome.status}` : causeChain(outcome).join(" <- ");

/**
 * One registry entry backed by several models, tried in order. A candidate is skipped when
 * it fails before producing output: an adapter failure (`aiSDKModel` fails with
 * `ModelUpstreamRejected` when the provider errors before its first token) or an answer
 * with status 429 or 5xx (`nativeModel` passes the provider's status through). Output that
 * already started streaming is never retried on another model. Each candidate is built
 * only when its turn comes, and the last outcome answers when every candidate failed.
 */
export function fallbackModel(candidates: Record<string, ModelRegistration>): EffectModelAdapter {
  const names = Object.keys(candidates);
  if (names.length === 0) throw new Error("fallbackModel needs at least one model");
  return modelAdapter((request) =>
    Effect.gen(function* () {
      const bytes = yield* io("model.body", () => request.arrayBuffer());
      const call = (name: string) =>
        Effect.gen(function* () {
          const adapter = yield* attempt("model.registration", () =>
            resolveModel(candidates[name] as ModelRegistration),
          );
          const copy = new Request(request, { body: bytes, signal: request.signal });
          const response =
            "effect" in adapter
              ? yield* (adapter as EffectModelAdapter).effect(copy)
              : yield* io("model.inference", () => adapter.fetch(copy));
          return response;
        });
      let last: ServiceError | Response | undefined;
      for (const [index, name] of names.entries()) {
        if (request.signal.aborted) break;
        const outcome = yield* call(name).pipe(Effect.either);
        if (outcome._tag === "Right" && !rejected(outcome.right)) return outcome.right;
        last = outcome._tag === "Right" ? outcome.right : outcome.left;
        const next = names[index + 1];
        if (next === undefined) break;
        console.warn("Model fallback", { from: name, to: next, cause: describeOutcome(last) });
        const discarded = last;
        if (discarded instanceof Response)
          yield* io("model.discard", () => discarded.body?.cancel() ?? Promise.resolve()).pipe(
            Effect.ignore,
          );
      }
      if (last instanceof Response) return last;
      return yield* Effect.fail(last ?? new ModelUpstreamRejected());
    }),
  );
}
class Models extends Context.Tag("agent-api/Models")<
  Models,
  Readonly<Record<string, ModelRegistration>>
>() {}
const resolveModel = (registration: ModelRegistration): ModelAdapter =>
  typeof registration === "function" ? registration() : registration;

/**
 * Compose behind a private Service Binding, never a public unauthenticated route.
 * A registry entry may be a factory (`() => nativeModel(...)`) so a deployment that
 * lacks one provider's credentials still serves its other presets.
 */
export function createModelGateway<Env>(models: (env: Env) => Record<string, ModelRegistration>): {
  fetch(request: Request, env: Env): Promise<Response>;
} {
  return {
    fetch: (request, env) =>
      // lint: entrypoint
      runPromise(
        Effect.gen(function* () {
          if (request.method !== "POST") return new Response(null, { status: 405 });
          const bytes = yield* readModelBodyEffect(request);
          const body = yield* attempt(
            "model.json",
            () => JSON.parse(new TextDecoder().decode(bytes)) as { model?: unknown } | null,
          );
          const registry = yield* Models;
          if (!body || typeof body.model !== "string" || !Object.hasOwn(registry, body.model))
            return yield* new ModelNotFound({ model: String(body?.model) });
          const registration = registry[body.model];
          const adapter = registration
            ? yield* attempt("model.registration", () => resolveModel(registration))
            : undefined;
          if (!adapter) return yield* new ModelNotFound({ model: body.model });
          return yield* io("model.inference", (signal) =>
            adapter.fetch(
              new Request(request, {
                ...(request.method === "GET" || request.method === "HEAD" ? {} : { body: bytes }),
                signal: AbortSignal.any([request.signal, signal]),
              }),
            ),
          );
        }).pipe(
          Effect.provide(Layer.sync(Models, () => models(env))),
          // A definite failure answers with its projection; an I/O failure stays a 400.
          Effect.catchAll((error) => Effect.succeed(gatewayFailure(error))),
        ),
      ),
  };
}
