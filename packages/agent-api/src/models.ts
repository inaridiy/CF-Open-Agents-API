import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  jsonSchema,
  type LanguageModel,
  type LanguageModelUsage,
  Output,
  streamText,
  tool,
} from "ai";
import { Effect } from "effect";

import { io } from "./effect.js";
import { ModelUpstreamRejected } from "./errors.js";
import { type EffectModelAdapter, fetchWithoutRedirect, modelAdapter } from "./models/gateway.js";
import {
  decodeModelRequest,
  type ModelInput,
  type OutputSchema,
  type ReasoningEffort,
} from "./models/input.js";
import { encodeModelResponse, type ModelChunk } from "./models/output.js";

// The gateway, the native adapter and the error sanitizer need no AI SDK; they live in
// `models/gateway.ts` so `cf-open-agents-api/cloudflare` never loads the optional `ai` peer.
export {
  createModelGateway,
  type EffectModelAdapter,
  fallbackModel,
  fetchWithoutRedirect,
  type ModelAdapter,
  modelAdapter,
  type ModelRegistration,
  nativeModel,
  sanitizeProviderError,
} from "./models/gateway.js";

type ProviderOptions = NonNullable<Parameters<typeof streamText>[0]["providerOptions"]>;
/** Settings decoded from the harness request that a deployment may map to provider options. */
export interface ModelSettings {
  reasoningEffort?: ReasoningEffort;
  outputSchema?: OutputSchema;
}
export interface AIModelOptions {
  /** Upper bound on output tokens; unset, the provider's own limit applies. */
  maxOutputTokens?: number;
  /** Abort a request after this long; unset, only the turn deadline bounds it. */
  timeoutMs?: number;
  /** Static provider options, or a mapping from the decoded request settings. */
  providerOptions?: ProviderOptions | ((settings: ModelSettings) => ProviderOptions | undefined);
}
/** The smaller of two optional limits, or none when neither is set. */
function bound(requested: number | undefined, allowed: number | undefined): number | undefined {
  if (requested === undefined) return allowed;
  return allowed === undefined ? requested : Math.min(requested, allowed);
}
/** The AI SDK's provider-neutral reasoning levels stop at `xhigh`; `max` rounds down. */
function standardReasoning(
  effort: ReasoningEffort | undefined,
): Parameters<typeof streamText>[0]["reasoning"] {
  if (effort === undefined) return;
  return effort === "max" ? "xhigh" : effort;
}
function structuredOutput(schema: OutputSchema | undefined) {
  if (schema === undefined) return;
  if (!schema.schema) return Output.json(schema.name ? { name: schema.name } : {});
  return Output.object({
    schema: jsonSchema(schema.schema),
    ...(schema.name ? { name: schema.name } : {}),
    ...(schema.description ? { description: schema.description } : {}),
  });
}
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
        // The tighter of what the harness asked for and what the deployment allows; with
        // neither, the provider's own output limit applies.
        maxOutputTokens: bound(input.maxOutputTokens, options.maxOutputTokens),
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
        // No timeout of its own: the turn deadline and the runtime's stream handling
        // bound a request unless the deployment sets `timeoutMs`.
        abortSignal: AbortSignal.any([
          request.signal,
          controller.signal,
          ...(options.timeoutMs === undefined ? [] : [AbortSignal.timeout(options.timeoutMs)]),
        ]),
      });
      type Part =
        Awaited<ReturnType<(typeof result.fullStream)[typeof Symbol.asyncIterator]>> extends {
          next(): Promise<IteratorResult<infer P>>;
        }
          ? P
          : never;
      const parts = result.fullStream[Symbol.asyncIterator]();
      const abort = Effect.sync(() => controller.abort());
      // Nothing is committed to the harness until the upstream has answered with output
      // or a finish; an error before that fails the request, so a fallback can try the
      // next model with the same request.
      const first = yield* io("model.first", async () => {
        for (;;) {
          const next = await parts.next();
          if (next.done || substantive(next.value.type)) return next;
        }
      }).pipe(Effect.onError(() => abort));
      if (!first.done && first.value.type === "error") {
        // The provider's message names the reason (capacity, quota, a bad key) for the
        // gateway's log line; request and response bodies stay out of it.
        console.warn("Model upstream rejected the request", {
          model: input.model,
          cause: providerErrorSummary(first.value.error),
        });
        controller.abort();
        return yield* new ModelUpstreamRejected();
      }
      function translate(part: Part): ModelChunk | undefined {
        switch (part.type) {
          case "text-delta":
            return { type: "text", id: part.id, text: part.text };
          case "reasoning-delta":
            return { type: "reasoning", id: part.id, text: part.text };
          case "tool-call":
            if (part.invalid) throw new Error("Model returned an invalid tool call");
            return { type: "call", id: part.toolCallId, name: part.toolName, input: part.input };
          // Provider-private signatures and encrypted content remain native-only.
          case "error":
            throw new Error("Upstream model request failed", {
              cause: providerErrorSummary(part.error),
            });
          case "finish":
            return { type: "finish", reason: part.finishReason, usage: part.totalUsage };
          default:
            return undefined;
        }
      }
      async function* chunks(): AsyncGenerator<ModelChunk> {
        for (let next = first; !next.done; next = await parts.next()) {
          const chunk = translate(next.value);
          if (chunk) yield chunk;
        }
      }
      return yield* io("model.encode", () =>
        encodeModelResponse(input, chunks(), () => controller.abort()),
      ).pipe(Effect.onError(() => abort));
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

export type { LanguageModelUsage };

/** The stream parts that carry output or an outcome; the rest are framing. */
const substantive = (type: string) =>
  ["text-delta", "reasoning-delta", "tool-call", "finish", "error"].includes(type);
/** One line naming a provider failure, never its request or response bodies. */
function providerErrorSummary(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return typeof error === "string" ? error : "unknown provider error";
}
