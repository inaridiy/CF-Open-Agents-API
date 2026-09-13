import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { jsonSchema, type LanguageModel, type LanguageModelUsage, streamText, tool } from "ai";
import { Context, Effect, Layer } from "effect";
import { attempt, io, runPromise, type ServiceError } from "./effect.js";
import { readModelBodyEffect } from "./models/body.js";
import { decodeModelRequest } from "./models/input.js";
import { encodeModelResponse, type ModelChunk } from "./models/output.js";
import { ApiError } from "./protocol.js";

/** A single model request. The native harness owns the agent loop and its tools. */
export interface ModelAdapter {
  fetch(request: Request): Promise<Response>;
}

export interface EffectModelAdapter extends ModelAdapter {
  readonly effect: (request: Request) => Effect.Effect<Response, ServiceError>;
}
export const modelAdapter = (effect: EffectModelAdapter["effect"]): EffectModelAdapter => ({
  effect,
  fetch: (request) => runPromise(effect(request)),
});

export interface AIModelOptions {
  maxOutputTokens?: number;
  timeoutMs?: number;
  providerOptions?: Parameters<typeof streamText>[0]["providerOptions"];
}

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
            .map((message) => message.content as string)
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
        providerOptions: options.providerOptions,
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
            case "tool-call":
              if (part.invalid) throw new Error("Model returned an invalid tool call");
              yield {
                type: "call",
                id: part.toolCallId,
                name: part.toolName,
                input: part.input,
              };
              break;
            // The portable contract carries text and function calls. Provider-private
            // reasoning/signatures stay within this inference; use nativeModel to replay them.
            case "error":
              throw new Error("Upstream model request failed");
            case "finish":
              yield { type: "finish", reason: part.finishReason, usage: part.totalUsage };
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
}

/** Chat Completions upstream; the gateway translates the harness's wire protocol. */
export function openAICompatibleModel(options: OpenAICompatibleOptions): EffectModelAdapter {
  const provider = createOpenAICompatible({
    name: "compatible",
    baseURL: options.baseURL,
    apiKey: options.apiKey,
    headers: options.headers,
    fetch: options.fetch,
  });
  return aiSDKModel(provider(options.model), options);
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
        return yield* new ApiError(
          400,
          "model_protocol_mismatch",
          "Model preset does not support this harness protocol",
        );
      const body = yield* io("model.body", () => request.json<Record<string, unknown>>());
      const headers = new Headers({ "content-type": "application/json" });
      if (options.protocol === "anthropic") {
        headers.set("x-api-key", options.apiKey);
        headers.set("anthropic-version", request.headers.get("anthropic-version") ?? "2023-06-01");
        const beta = request.headers.get("anthropic-beta");
        if (beta) headers.set("anthropic-beta", beta);
      } else headers.set("authorization", `Bearer ${options.apiKey}`);
      return yield* io("model.fetch", (signal) =>
        (options.fetch ?? globalThis.fetch)(new URL(path.slice(1), base), {
          method: "POST",
          headers,
          body: JSON.stringify({ ...body, model: options.model }),
          signal: AbortSignal.any([request.signal, signal]),
          redirect: "error",
        }),
      );
    }),
  );
}

class Models extends Context.Tag("agent-api/Models")<
  Models,
  Readonly<Record<string, ModelAdapter>>
>() {}

/** Compose behind a private Service Binding, never a public unauthenticated route. */
export function createModelGateway<Env>(models: (env: Env) => Record<string, ModelAdapter>): {
  fetch(request: Request, env: Env): Promise<Response>;
} {
  return {
    fetch: (request, env) =>
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
            return yield* new ApiError(
              404,
              "model_not_found",
              "No model is registered with this name",
            );
          const adapter = registry[body.model];
          if (!adapter)
            return yield* new ApiError(
              404,
              "model_not_found",
              "No model is registered with this name",
            );
          return yield* io("model.inference", () =>
            adapter.fetch(new Request(request, { body: bytes })),
          );
        }).pipe(
          Effect.provide(Layer.sync(Models, () => models(env))),
          Effect.catchAll((error) =>
            Effect.succeed(
              Response.json(
                {
                  error: {
                    type: "model_gateway_error",
                    message:
                      error instanceof ApiError
                        ? error.message
                        : "Invalid or unsupported model request",
                  },
                },
                { status: error instanceof ApiError ? error.status : 400 },
              ),
            ),
          ),
        ),
      ),
  };
}

export type { LanguageModelUsage };
