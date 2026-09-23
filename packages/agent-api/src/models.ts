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
