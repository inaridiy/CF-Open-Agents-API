import type { FinishReason, LanguageModelUsage } from "ai";
import { ApiError } from "../protocol.js";
import type { ModelInput } from "./input.js";

export type ModelChunk =
  | { type: "text" | "reasoning"; id: string; text: string }
  | { type: "call"; id: string; name: string; input: unknown }
  | { type: "finish"; reason: FinishReason; usage: LanguageModelUsage };

interface Item {
  id: string;
  type: "text" | "reasoning" | "call";
  text: string;
  name?: string;
  input?: unknown;
}
const id = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
const event = (type: string, data: object) =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;

/** Encodes one inference, without executing tools or retaining conversation state. */
export async function encodeModelResponse(
  input: ModelInput,
  source: AsyncIterable<ModelChunk>,
  abort: () => void,
): Promise<Response> {
  const responseId = id("resp");
  const created = Math.floor(Date.now() / 1000);
  const items: Item[] = [];
  let usage = {
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens_details: { reasoning_tokens: 0 },
  };
  let cacheWrite = 0;
  const anthropicUsage = () => ({
    input_tokens: Math.max(
      0,
      usage.input_tokens - usage.input_tokens_details.cached_tokens - cacheWrite,
    ),
    output_tokens: usage.output_tokens,
    cache_read_input_tokens: usage.input_tokens_details.cached_tokens,
    cache_creation_input_tokens: cacheWrite,
  });
  const chatUsage = () => ({
    prompt_tokens: usage.input_tokens,
    completion_tokens: usage.output_tokens,
    total_tokens: usage.total_tokens,
    prompt_tokens_details: usage.input_tokens_details,
    completion_tokens_details: usage.output_tokens_details,
  });
  let finish: FinishReason | undefined;
  let sequence = 0;
  const responsesEvent = (type: string, data: object) =>
    event(type, { sequence_number: sequence++, ...data });
  const responsesItem = (item: Item): Record<string, unknown> => {
    if (item.type === "reasoning")
      return {
        id: item.id,
        type: "reasoning",
        summary: [{ type: "summary_text", text: item.text }],
      };
    if (item.type === "text")
      return {
        id: item.id,
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: item.text, annotations: [] }],
      };
    const definition = input.tools.find((tool) => tool.name === item.name);
    if (definition?.search)
      return {
        id: item.id,
        call_id: item.id,
        status: "completed",
        type: "tool_search_call",
        execution: "client",
        arguments: item.input,
      };
    const common = {
      status: "completed",
      id: item.id,
      call_id: item.id,
      name: definition?.wireName ?? item.name,
      ...(definition?.namespace ? { namespace: definition.namespace } : {}),
    };
    return definition?.custom
      ? { ...common, type: "custom_tool_call", input: (item.input as { input: string }).input }
      : { ...common, type: "function_call", arguments: JSON.stringify(item.input) };
  };
  const response = (status: string) => ({
    id: responseId,
    object: "response",
    created_at: created,
    model: input.model,
    status,
    output: items.map(responsesItem),
    usage,
  });
  const anthropicItem = (item: Item) =>
    item.type === "call"
      ? { type: "tool_use", id: item.id, name: item.name, input: item.input }
      : item.type === "reasoning"
        ? { type: "thinking", thinking: item.text, signature: "" }
        : { type: "text", text: item.text };
  const chatChunk = (delta: object, reason: string | null = null, includeUsage = false) =>
    `data: ${JSON.stringify({
      id: responseId,
      object: "chat.completion.chunk",
      created,
      model: input.model,
      choices: [{ index: 0, delta, finish_reason: reason }],
      ...(includeUsage
        ? {
            usage: chatUsage(),
          }
        : {}),
    })}\n\n`;
  async function* encode(): AsyncGenerator<string> {
    try {
      if (input.stream) {
        if (input.protocol === "responses")
          yield responsesEvent("response.created", { response: response("in_progress") });
        else if (input.protocol === "anthropic")
          yield event("message_start", {
            message: {
              id: responseId,
              type: "message",
              role: "assistant",
              model: input.model,
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: anthropicUsage(),
            },
          });
        else yield chatChunk({ role: "assistant", content: "" });
      }
      let bytes = 0;
      for await (const chunk of source) {
        bytes += new TextEncoder().encode(JSON.stringify(chunk)).byteLength;
        if (bytes > 8 * 1024 * 1024) throw new Error("Model output exceeds 8 MiB");
        if (chunk.type === "finish") {
          finish = chunk.reason;
          usage = {
            input_tokens: chunk.usage.inputTokens ?? 0,
            output_tokens: chunk.usage.outputTokens ?? 0,
            total_tokens: chunk.usage.totalTokens ?? 0,
            input_tokens_details: {
              cached_tokens: chunk.usage.inputTokenDetails.cacheReadTokens ?? 0,
            },
            output_tokens_details: {
              reasoning_tokens: chunk.usage.outputTokenDetails.reasoningTokens ?? 0,
            },
          };
          cacheWrite = chunk.usage.inputTokenDetails.cacheWriteTokens ?? 0;
          continue;
        }
        let index = items.findIndex((item) => item.id === chunk.id && item.type === chunk.type);
        const fresh = index < 0;
        if (fresh) {
          index = items.length;
          items.push({
            id: chunk.id,
            type: chunk.type,
            text: "",
            ...(chunk.type === "call" ? { name: chunk.name, input: chunk.input } : {}),
          });
        }
        const item = items[index];
        if (!item) throw new Error("Missing model output item");
        if (input.stream && fresh) {
          if (input.protocol === "responses") {
            yield responsesEvent("response.output_item.added", {
              output_index: index,
              item: { ...responsesItem(item), status: "in_progress" },
            });
            if (chunk.type === "text")
              yield responsesEvent("response.content_part.added", {
                item_id: item.id,
                output_index: index,
                content_index: 0,
                part: { type: "output_text", text: "", annotations: [] },
              });
            else if (chunk.type === "reasoning")
              yield responsesEvent("response.reasoning_summary_part.added", {
                item_id: item.id,
                output_index: index,
                summary_index: 0,
                part: { type: "summary_text", text: "" },
              });
          } else if (input.protocol === "anthropic")
            yield event("content_block_start", {
              index,
              content_block:
                chunk.type === "call"
                  ? { type: "tool_use", id: item.id, name: item.name, input: {} }
                  : anthropicItem(item),
            });
        }
        if (chunk.type !== "call") item.text += chunk.text;
        if (!input.stream) continue;
        if (input.protocol === "responses") {
          if (chunk.type === "text")
            yield responsesEvent("response.output_text.delta", {
              item_id: item.id,
              output_index: index,
              content_index: 0,
              delta: chunk.text,
            });
          else if (chunk.type === "reasoning")
            yield responsesEvent("response.reasoning_summary_text.delta", {
              item_id: item.id,
              output_index: index,
              summary_index: 0,
              delta: chunk.text,
            });
        } else if (input.protocol === "anthropic") {
          const delta =
            chunk.type === "call"
              ? { type: "input_json_delta", partial_json: JSON.stringify(chunk.input) }
              : chunk.type === "reasoning"
                ? { type: "thinking_delta", thinking: chunk.text }
                : { type: "text_delta", text: chunk.text };
          yield event("content_block_delta", { index, delta });
        } else {
          if (chunk.type === "call")
            yield chatChunk({
              tool_calls: [
                {
                  index: items.slice(0, index).filter((value) => value.type === "call").length,
                  id: item.id,
                  type: "function",
                  function: { name: item.name, arguments: JSON.stringify(item.input) },
                },
              ],
            });
          else
            yield chatChunk(
              chunk.type === "reasoning"
                ? { reasoning_content: chunk.text }
                : { content: chunk.text },
            );
        }
      }
      if (!finish || !["stop", "tool-calls"].includes(finish))
        throw new Error("Upstream output is incomplete");
      const hasCalls = items.some((item) => item.type === "call");
      if (!input.stream) {
        if (input.protocol === "responses") yield JSON.stringify(response("completed"));
        else if (input.protocol === "anthropic")
          yield JSON.stringify({
            id: responseId,
            type: "message",
            role: "assistant",
            model: input.model,
            content: items.map(anthropicItem),
            stop_reason: hasCalls ? "tool_use" : "end_turn",
            stop_sequence: null,
            usage: anthropicUsage(),
          });
        else
          yield JSON.stringify({
            id: responseId,
            object: "chat.completion",
            created,
            model: input.model,
            choices: [
              {
                index: 0,
                finish_reason: hasCalls ? "tool_calls" : "stop",
                message: {
                  role: "assistant",
                  content: items
                    .filter((item) => item.type === "text")
                    .map((item) => item.text)
                    .join(""),
                  reasoning_content:
                    items
                      .filter((item) => item.type === "reasoning")
                      .map((item) => item.text)
                      .join("") || undefined,
                  ...(hasCalls
                    ? {
                        tool_calls: items
                          .filter((item) => item.type === "call")
                          .map((item) => ({
                            id: item.id,
                            type: "function",
                            function: { name: item.name, arguments: JSON.stringify(item.input) },
                          })),
                      }
                    : {}),
                },
              },
            ],
            usage: chatUsage(),
          });
        return;
      }
      for (const [index, item] of items.entries()) {
        if (input.protocol === "responses") {
          if (item.type === "text") {
            yield responsesEvent("response.output_text.done", {
              item_id: item.id,
              output_index: index,
              content_index: 0,
              text: item.text,
            });
            yield responsesEvent("response.content_part.done", {
              item_id: item.id,
              output_index: index,
              content_index: 0,
              part: { type: "output_text", text: item.text, annotations: [] },
            });
          }
          if (item.type === "reasoning") {
            yield responsesEvent("response.reasoning_summary_text.done", {
              item_id: item.id,
              output_index: index,
              summary_index: 0,
              text: item.text,
            });
            yield responsesEvent("response.reasoning_summary_part.done", {
              item_id: item.id,
              output_index: index,
              summary_index: 0,
              part: { type: "summary_text", text: item.text },
            });
          }
          yield responsesEvent("response.output_item.done", {
            output_index: index,
            item: responsesItem(item),
          });
        } else if (input.protocol === "anthropic") yield event("content_block_stop", { index });
      }
      if (input.protocol === "responses")
        yield responsesEvent("response.completed", { response: response("completed") });
      else if (input.protocol === "anthropic") {
        yield event("message_delta", {
          delta: { stop_reason: hasCalls ? "tool_use" : "end_turn", stop_sequence: null },
          usage: anthropicUsage(),
        });
        yield event("message_stop", {});
      } else {
        yield chatChunk({}, hasCalls ? "tool_calls" : "stop", true);
        yield "data: [DONE]\n\n";
      }
    } catch {
      if (!input.stream)
        throw new ApiError(
          503,
          "model_output_failed",
          "Upstream model output failed or was incomplete",
        );
      if (input.protocol === "responses")
        yield responsesEvent("response.failed", {
          response: {
            ...response("failed"),
            error: {
              code: "model_output_failed",
              message: "Upstream model output failed or was incomplete",
            },
          },
        });
      else
        yield event("error", {
          error: {
            type: "model_output_failed",
            message: "Upstream model output failed or was incomplete",
          },
        });
    } finally {
      abort();
    }
  }
  const iterator = encode();
  const encoder = new TextEncoder();
  if (!input.stream) {
    let body = "";
    for await (const part of iterator) body += part;
    return new Response(body, {
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  }
  return new Response(
    new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await iterator.next();
          if (next.done) controller.close();
          else controller.enqueue(encoder.encode(next.value));
        } catch (error) {
          controller.error(error);
        }
      },
      async cancel() {
        abort();
        await iterator.return(undefined);
      },
    }),
    {
      headers: {
        "content-type": input.stream ? "text/event-stream" : "application/json",
        "cache-control": "no-store",
      },
    },
  );
}
