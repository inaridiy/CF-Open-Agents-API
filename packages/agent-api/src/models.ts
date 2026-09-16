import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  jsonSchema,
  type LanguageModel,
  type LanguageModelUsage,
  Output,
  streamText,
  tool,
} from "ai";
import { Context, Effect, Layer } from "effect";

import { attempt, io, runPromise, type ServiceError } from "./effect.js";
import { ModelNotFound, ModelProtocolMismatch, projectApiError } from "./errors.js";
import { requestWithoutRedirect } from "./http.js";
import { readModelBodyEffect } from "./models/body.js";
import {
  decodeModelRequest,
  type ModelInput,
  type OutputSchema,
  type ReasoningEffort,
} from "./models/input.js";
import { encodeModelResponse, type ModelChunk } from "./models/output.js";

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

type ProviderOptions = NonNullable<Parameters<typeof streamText>[0]["providerOptions"]>;
/** Settings decoded from the harness request that a deployment may map to provider options. */
export interface ModelSettings {
  reasoningEffort?: ReasoningEffort;
  outputSchema?: OutputSchema;
}
export interface AIModelOptions {
  maxOutputTokens?: number;
  timeoutMs?: number;
  /** Static provider options, or a mapping from the decoded request settings. */
  providerOptions?: ProviderOptions | ((settings: ModelSettings) => ProviderOptions | undefined);
}
/** The AI SDK's provider-neutral reasoning levels stop at `xhigh`; `max` rounds down. */
const standardReasoning = (
  effort: ReasoningEffort | undefined,
): Parameters<typeof streamText>[0]["reasoning"] =>
  effort === undefined ? undefined : effort === "max" ? "xhigh" : effort;
const structuredOutput = (schema: OutputSchema | undefined) =>
  schema === undefined
    ? undefined
    : schema.schema
      ? Output.object({
          schema: jsonSchema(schema.schema),
          ...(schema.name ? { name: schema.name } : {}),
          ...(schema.description ? { description: schema.description } : {}),
        })
      : Output.json(schema.name ? { name: schema.name } : {});
const settingsOf = (input: ModelInput): ModelSettings => ({
  ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
  ...(input.outputSchema ? { outputSchema: input.outputSchema } : {}),
});

/** Accepts an already instantiated AI SDK model, including Workers AI providers. */
export function aiSDKModel(model: LanguageModel, options: AIModelOptions = {}): EffectModelAdapter {
  return modelAdapter((request) =>
    Effect.gen(function* () {
      const input = yield* io("model.decode", () => decodeModelRequest(request));
      const controller = new AbortController();
      const result = streamText({
        model,
        instructions:
          input.messages
            .filter((message) => message.role === "system")
            .map((message) => message.content)
            .join("\n\n") || undefined,
        messages: input.messages.filter((message) => message.role !== "system"),
        tools: Object.fromEntries(
          input.tools.map((definition) => [
            definition.name,
            tool({
              description: definition.description,
              inputSchema: jsonSchema(definition.schema),
            }),
          ]),
        ),
        toolChoice: input.toolChoice,
        temperature: input.temperature,
        topP: input.topP,
        maxOutputTokens: Math.min(input.maxOutputTokens ?? 8192, options.maxOutputTokens ?? 8192),
        reasoning: standardReasoning(input.reasoningEffort),
        // With a structured output the model's text is the JSON document; the
        // harness validates it, so the stream is forwarded without a second parse.
        output: structuredOutput(input.outputSchema),
        providerOptions:
          typeof options.providerOptions === "function"
            ? options.providerOptions(settingsOf(input))
            : options.providerOptions,
        maxRetries: 0,
        onError: () => {}, // Return a sanitized protocol error; never log provider request bodies.
        abortSignal: AbortSignal.any([
          request.signal,
          controller.signal,
          AbortSignal.timeout(options.timeoutMs ?? 120_000),
        ]),
      });
      async function* chunks(): AsyncGenerator<ModelChunk> {
        for await (const part of result.fullStream) {
          switch (part.type) {
            case "text-delta":
              yield { type: "text", id: part.id, text: part.text };
              break;
            case "reasoning-delta":
              yield { type: "reasoning", id: part.id, text: part.text };
              break;
            case "tool-call":
              if (part.invalid) throw new Error("Model returned an invalid tool call");
              yield {
                type: "call",
                id: part.toolCallId,
                name: part.toolName,
                input: part.input,
              };
              break;
            // Provider-private signatures and encrypted content remain native-only.
            case "error":
              throw new Error("Upstream model request failed");
            case "finish":
              yield { type: "finish", reason: part.finishReason, usage: part.totalUsage };
              break;
            default:
              break;
          }
        }
      }
      return yield* io("model.encode", () =>
        encodeModelResponse(input, chunks(), () => controller.abort()),
      ).pipe(Effect.onError(() => Effect.sync(() => controller.abort())));
    }),
  );
}

export interface OpenAICompatibleOptions extends AIModelOptions {
  baseURL: string;
  apiKey: string;
  model: string;
  headers?: Record<string, string>;
  fetch?: typeof globalThis.fetch;
  /** Send `response_format: json_schema` for structured output (default); `false` falls back to `json_object`. */
  supportsStructuredOutputs?: boolean;
}

/** A fetch that never follows redirects, so configured credentials stay with the configured host. */
export function fetchWithoutRedirect(
  send: typeof globalThis.fetch = fetch,
): typeof globalThis.fetch {
  return async (input, init) => {
    const response = await send(input, { ...init, redirect: "manual" });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => {});
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

/** Chat Completions upstream; the gateway translates the harness's wire protocol. */
export function openAICompatibleModel(options: OpenAICompatibleOptions): EffectModelAdapter {
  const provider = createOpenAICompatible({
    name: "compatible",
    baseURL: options.baseURL,
    apiKey: options.apiKey,
    headers: options.headers,
    fetch: fetchWithoutRedirect(options.fetch),
    supportsStructuredOutputs: options.supportsStructuredOutputs ?? true,
  });
  return aiSDKModel(provider(options.model), options);
}

const PROVIDER_ERROR_LIMIT = 64 * 1024;
const SECRET_PATTERN = /\b[A-Za-z]{1,8}-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._-]{8,}/g;
async function readBounded(response: Response, limit: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (text.length < limit) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value as Uint8Array, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return text.slice(0, limit);
}
/**
 * Provider error bodies can echo request headers, including masked keys. Keep the
 * status, the structured error fields and Retry-After; drop everything else.
 */
export async function sanitizeProviderError(response: Response): Promise<Response> {
  const text = await readBounded(response, PROVIDER_ERROR_LIMIT);
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

export type { LanguageModelUsage };
