import type { FilePart, ModelMessage, ToolResultPart, UserContent } from "ai";
import { z } from "zod";

import { ApiError, canonicalJSON } from "../protocol.js";

export interface ModelInput {
  protocol: "responses" | "anthropic" | "chat-completions";
  model: string;
  stream: boolean;
  messages: ModelMessage[];
  tools: {
    name: string;
    wireName: string;
    namespace?: string;
    description?: string;
    schema: Record<string, unknown>;
    custom: boolean;
    search?: boolean;
  }[];
  toolChoice?: "auto" | "none" | "required" | { type: "tool"; toolName: string };
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  /** Reasoning effort requested by the harness, in the OpenAI Agents API vocabulary. */
  reasoningEffort?: ReasoningEffort;
  /** Structured output requested by the harness; a missing schema means "any JSON object". */
  outputSchema?: OutputSchema;
}
export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export interface OutputSchema {
  schema?: Record<string, unknown>;
  name?: string;
  description?: string;
}
const effortSchema = z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);

const object = z.record(z.string(), z.unknown());
const list = z.array(object);
const unsupported = () =>
  new ApiError(
    400,
    "unsupported_model_input",
    "Unsupported translated model input; use a native model preset for provider-specific content",
  );
const string = (value: unknown) => z.string().parse(value);
function text(content: unknown): string {
  if (typeof content === "string") return content;
  return list
    .parse(content)
    .map((part) => {
      if (!["text", "input_text", "output_text"].includes(string(part.type))) throw unsupported();
      return string(part.text);
    })
    .join("\n");
}

function image(part: Record<string, unknown>): FilePart {
  const url = (value: unknown): FilePart => ({
    type: "file",
    mediaType: "image",
    data: { type: "url", url: new URL(string(value)) },
  });
  if (part.type === "input_image") return url(part.image_url);
  if (part.type === "image_url") return url(object.parse(part.image_url).url);
  const source = object.parse(part.source);
  if (source.type === "url") return url(source.url);
  if (source.type === "base64")
    return {
      type: "file",
      data: { type: "data", data: string(source.data) },
      mediaType: string(source.media_type),
    };
  throw unsupported();
}
function userContent(content: unknown): UserContent {
  if (typeof content === "string") return content;
  return list.parse(content).map((part) => {
    if (["text", "input_text", "output_text"].includes(string(part.type)))
      return { type: "text" as const, text: string(part.text) };
    if (["input_image", "image_url", "image"].includes(string(part.type))) return image(part);
    throw unsupported();
  });
}
function toolOutput(content: unknown, failed: boolean): ToolResultPart["output"] {
  if (typeof content === "string") return { type: failed ? "error-text" : "text", value: content };
  const parts = userContent(content);
  if (typeof parts === "string") throw unsupported();
  return {
    type: "content",
    value: parts.map((part) => {
      if (part.type === "text") return { type: "text" as const, text: part.text };
      if (
        part.type !== "file" ||
        typeof part.data !== "object" ||
        part.data === null ||
        !("type" in part.data) ||
        (part.data.type !== "data" && part.data.type !== "url")
      )
        throw unsupported();
      return { type: "file" as const, data: part.data, mediaType: part.mediaType };
    }),
  };
}

const optionalString = (value: unknown) =>
  z.string().optional().nullable().parse(value) ?? undefined;
/**
 * Responses carries `reasoning.effort`, Chat Completions `reasoning_effort`, and the
 * Messages API either `output_config.effort` or a `thinking` budget. A budget is
 * folded into the nearest named level; `adaptive` leaves the provider default.
 */
function decodeReasoningEffort(
  protocol: ModelInput["protocol"],
  body: Record<string, unknown>,
): ReasoningEffort | undefined {
  const effort = effortSchema.optional().nullable();
  if (protocol === "responses")
    return body.reasoning
      ? (effort.parse(object.parse(body.reasoning).effort) ?? undefined)
      : undefined;
  if (protocol === "chat-completions") return effort.parse(body.reasoning_effort) ?? undefined;
  const configured = body.output_config
    ? effort.parse(object.parse(body.output_config).effort)
    : undefined;
  if (configured) return configured;
  if (!body.thinking) return undefined;
  const thinking = object.parse(body.thinking);
  if (thinking.type === "disabled") return "none";
  if (thinking.type === "enabled") {
    const budget = z.number().nonnegative().parse(thinking.budget_tokens);
    return budget >= 32_000 ? "high" : budget >= 8_000 ? "medium" : "low";
  }
  return undefined;
}
/**
 * Responses `text.format`, Chat `response_format` and Messages `output_config.format`
 * all describe the same request: a JSON object, optionally constrained by a schema.
 */
function decodeOutputSchema(
  protocol: ModelInput["protocol"],
  body: Record<string, unknown>,
): OutputSchema | undefined {
  const raw =
    protocol === "responses"
      ? ((body.text ? object.parse(body.text).format : undefined) ??
        (body.output_config ? object.parse(body.output_config).format : undefined))
      : protocol === "chat-completions"
        ? body.response_format
        : ((body.output_config ? object.parse(body.output_config).format : undefined) ??
          body.output_format);
  if (raw === undefined || raw === null) return undefined;
  const format = object.parse(raw);
  if (format.type === "text") return undefined;
  if (format.type === "json_object") return {};
  if (format.type !== "json_schema") throw unsupported();
  // Chat Completions nests the schema under `json_schema`; the others keep it flat.
  const definition = format.json_schema ? object.parse(format.json_schema) : format;
  const schema = definition.schema === undefined ? undefined : object.parse(definition.schema);
  const name = optionalString(definition.name);
  const description = optionalString(definition.description);
  return {
    ...(schema ? { schema } : {}),
    ...(name ? { name } : {}),
    ...(description ? { description } : {}),
  };
}

export async function decodeModelRequest(request: Request): Promise<ModelInput> {
  const path = new URL(request.url).pathname;
  const protocol =
    path === "/v1/responses"
      ? "responses"
      : path === "/v1/messages"
        ? "anthropic"
        : path === "/v1/chat/completions"
          ? "chat-completions"
          : null;
  if (!protocol) throw unsupported();
  const body = object.parse(await request.json());
  if (body.previous_response_id || body.background || body.store === true) throw unsupported();
  const reasoningEffort = decodeReasoningEffort(protocol, body);
  const outputSchema = decodeOutputSchema(protocol, body);
  const output: ModelInput = {
    protocol,
    model: string(body.model),
    stream: body.stream === true,
    messages: [],
    tools: [],
    maxOutputTokens: z
      .number()
      .int()
      .positive()
      .optional()
      .parse(body.max_output_tokens ?? body.max_completion_tokens ?? body.max_tokens),
    temperature: z.number().optional().parse(body.temperature),
    topP: z.number().optional().parse(body.top_p),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(outputSchema ? { outputSchema } : {}),
  };
  const historyTools =
    protocol === "responses" && Array.isArray(body.input)
      ? list
          .parse(body.input)
          .filter((item) => item.type === "tool_search_output")
          .flatMap((item) => list.parse(item.tools))
      : [];
  const definitions: { raw: Record<string, unknown>; discovered: boolean }[] = [
    ...list.parse(body.tools ?? []).map((raw) => ({ raw, discovered: false })),
    ...historyTools.map((raw) => ({ raw, discovered: true })),
  ].flatMap(({ raw, discovered }) =>
    (raw.type === "namespace"
      ? list.parse(raw.tools).map((tool) => ({ ...tool, namespace: string(raw.name) }))
      : [raw]
    ).map((nested) => ({ raw: nested, discovered })),
  );
  for (const { raw, discovered } of definitions) {
    const definition = protocol === "chat-completions" ? object.parse(raw.function) : raw;
    const custom = raw.type === "custom";
    const search =
      protocol === "responses" && raw.type === "tool_search" && raw.execution === "client";
    if (protocol !== "anthropic" && raw.type !== "function" && !custom && !search)
      throw unsupported();
    const name = search
      ? "tool_search"
      : raw.namespace
        ? `${string(raw.namespace)}__${string(definition.name)}`
        : string(definition.name);
    const tool: ModelInput["tools"][number] = {
      name,
      wireName: search ? "tool_search" : string(definition.name),
      namespace: z.string().optional().parse(raw.namespace),
      description: z.string().optional().parse(definition.description),
      schema: custom
        ? {
            type: "object",
            properties: {
              input: {
                type: "string",
                description: "The exact raw input expected by this custom tool.",
              },
            },
            required: ["input"],
            additionalProperties: false,
          }
        : object.parse(definition.parameters ?? definition.input_schema),
      custom,
      ...(search ? { search: true } : {}),
    };
    const previous = output.tools.find((entry) => entry.name === name);
    if (previous) {
      if (discovered && canonicalJSON(previous) === canonicalJSON(tool)) continue;
      throw unsupported();
    }
    output.tools.push(tool);
  }
  if (new Set(output.tools.map((tool) => tool.name)).size !== output.tools.length)
    throw unsupported();
  const choice = body.tool_choice;
  if (typeof choice === "string")
    output.toolChoice = z.enum(["auto", "none", "required"]).parse(choice);
  else if (choice) {
    const selected = object.parse(choice);
    if (selected.type === "any") output.toolChoice = "required";
    else if (selected.type === "auto" || selected.type === "none")
      output.toolChoice = selected.type;
    else
      output.toolChoice = {
        type: "tool",
        toolName: string(selected.name ?? object.parse(selected.function).name),
      };
  }
  const calls = new Map<string, string>();
  const appendCall = (id: string, name: string, input: unknown) => {
    calls.set(id, name);
    output.messages.push({
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: id, toolName: name, input }],
    });
  };
  const appendResult = (id: string, value: unknown, failed = false) => {
    const name = calls.get(id);
    if (!name) throw unsupported();
    output.messages.push({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: id,
          toolName: name,
          output: toolOutput(value, failed),
        },
      ],
    });
  };
  if (protocol === "responses") {
    if (body.instructions)
      output.messages.push({ role: "system", content: string(body.instructions) });
    const items =
      typeof body.input === "string"
        ? [{ role: "user", content: body.input }]
        : list.parse(body.input);
    for (const item of items) {
      if (item.type === "tool_search_call")
        appendCall(string(item.call_id), "tool_search", item.arguments);
      else if (item.type === "tool_search_output")
        appendResult(string(item.call_id), JSON.stringify(item.tools));
      else if (item.type === "function_call" || item.type === "custom_tool_call")
        appendCall(
          string(item.call_id),
          item.namespace ? `${string(item.namespace)}__${string(item.name)}` : string(item.name),
          item.type === "custom_tool_call"
            ? { input: string(item.input) }
            : JSON.parse(string(item.arguments)),
        );
      else if (item.type === "function_call_output" || item.type === "custom_tool_call_output")
        appendResult(string(item.call_id), item.output);
      else if (item.type === "reasoning") {
        // Encrypted reasoning is opaque to other providers; native passthrough preserves it.
        if (item.encrypted_content) throw unsupported();
        const summary = list
          .parse(item.summary ?? [])
          .map((part) => string(part.text))
          .join("\n");
        if (summary)
          output.messages.push({
            role: "assistant",
            content: [{ type: "reasoning", text: summary }],
          });
      } else {
        if (item.type && item.type !== "message") throw unsupported();
        const role =
          item.role === "developer"
            ? "system"
            : z.enum(["user", "assistant", "system"]).parse(item.role);
        if (role === "user") output.messages.push({ role, content: userContent(item.content) });
        else output.messages.push({ role, content: text(item.content) });
      }
    }
  } else {
    if (body.system) output.messages.push({ role: "system", content: text(body.system) });
    for (const message of list.parse(body.messages)) {
      if (message.role === "tool") {
        appendResult(string(message.tool_call_id), message.content);
        continue;
      }
      const role =
        message.role === "developer"
          ? "system"
          : z.enum(["user", "assistant", "system"]).parse(message.role);
      if (typeof message.content === "string")
        output.messages.push({ role, content: message.content });
      else if (message.content) {
        for (const part of list.parse(message.content)) {
          if (part.type === "tool_use") appendCall(string(part.id), string(part.name), part.input);
          else if (part.type === "tool_result")
            appendResult(string(part.tool_use_id), part.content, part.is_error === true);
          else if (part.type === "text") output.messages.push({ role, content: string(part.text) });
          else if (role === "user" && ["image", "image_url"].includes(string(part.type)))
            output.messages.push({ role, content: [image(part)] });
          else if (role === "assistant" && part.type === "thinking")
            output.messages.push({
              role,
              content: [{ type: "reasoning", text: string(part.thinking) }],
            });
          else throw unsupported();
        }
      }
      if (role === "assistant" && typeof message.reasoning_content === "string")
        output.messages.push({
          role,
          content: [{ type: "reasoning", text: message.reasoning_content }],
        });
      for (const call of list.parse(message.tool_calls ?? [])) {
        const fn = object.parse(call.function);
        appendCall(string(call.id), string(fn.name), JSON.parse(string(fn.arguments)));
      }
    }
  }
  return output;
}
