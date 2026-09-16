import type { FilePart, ModelMessage, ToolResultPart, UserContent } from "ai";
import { z } from "zod";

import { ModelInputUnsupported } from "../errors.js";
import { canonicalJSON } from "../protocol.js";

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
const unsupported = () => new ModelInputUnsupported();
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
/** A thinking budget folded into the nearest named level. */
function effortForBudget(budget: number): ReasoningEffort {
  if (budget >= 32_000) return "high";
  if (budget >= 8_000) return "medium";
  return "low";
}
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
    return effortForBudget(z.number().nonnegative().parse(thinking.budget_tokens));
  }
  return undefined;
}
/** Where each protocol carries its output format, before any of it is validated. */
function rawOutputFormat(protocol: ModelInput["protocol"], body: Record<string, unknown>): unknown {
  if (protocol === "chat-completions") return body.response_format;
  const outputConfigFormat = () =>
    body.output_config ? object.parse(body.output_config).format : undefined;
  if (protocol === "responses")
    return (body.text ? object.parse(body.text).format : undefined) ?? outputConfigFormat();
  return outputConfigFormat() ?? body.output_format;
}
/**
 * Responses `text.format`, Chat `response_format` and Messages `output_config.format`
 * all describe the same request: a JSON object, optionally constrained by a schema.
 */
function decodeOutputSchema(
  protocol: ModelInput["protocol"],
  body: Record<string, unknown>,
): OutputSchema | undefined {
  const raw = rawOutputFormat(protocol, body);
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

type Protocol = ModelInput["protocol"];
type ToolDefinition = ModelInput["tools"][number];

function protocolFor(path: string): Protocol | null {
  if (path === "/v1/responses") return "responses";
  if (path === "/v1/messages") return "anthropic";
  if (path === "/v1/chat/completions") return "chat-completions";
  return null;
}
/** Responses tool definitions discovered by an earlier `tool_search` in the history. */
function historyTools(protocol: Protocol, body: Record<string, unknown>) {
  if (protocol !== "responses" || !Array.isArray(body.input)) return [];
  return list
    .parse(body.input)
    .filter((item) => item.type === "tool_search_output")
    .flatMap((item) => list.parse(item.tools));
}
/** A namespace definition expands into its member tools, each tagged with the namespace. */
function flattenNamespace(raw: Record<string, unknown>): Record<string, unknown>[] {
  if (raw.type !== "namespace") return [raw];
  return list.parse(raw.tools).map((tool) => ({ ...tool, namespace: string(raw.name) }));
}
/** A custom tool takes one raw string; every definition gets its own schema object. */
const customToolSchema = (): Record<string, unknown> => ({
  type: "object",
  properties: {
    input: { type: "string", description: "The exact raw input expected by this custom tool." },
  },
  required: ["input"],
  additionalProperties: false,
});
function decodeToolDefinition(protocol: Protocol, raw: Record<string, unknown>): ToolDefinition {
  const definition = protocol === "chat-completions" ? object.parse(raw.function) : raw;
  const custom = raw.type === "custom";
  const search =
    protocol === "responses" && raw.type === "tool_search" && raw.execution === "client";
  if (protocol !== "anthropic" && raw.type !== "function" && !custom && !search)
    throw unsupported();
  let name: string;
  if (search) name = "tool_search";
  else if (raw.namespace) name = `${string(raw.namespace)}__${string(definition.name)}`;
  else name = string(definition.name);
  return {
    name,
    wireName: search ? "tool_search" : string(definition.name),
    namespace: z.string().optional().parse(raw.namespace),
    description: z.string().optional().parse(definition.description),
    schema: custom
      ? customToolSchema()
      : object.parse(definition.parameters ?? definition.input_schema),
    custom,
    ...(search ? { search: true } : {}),
  };
}
/**
 * Declared tools first, then the ones a `tool_search` discovered earlier in the history;
 * a discovered duplicate of an identical definition is dropped, any other duplicate is
 * refused.
 */
function decodeTools(protocol: Protocol, body: Record<string, unknown>): ToolDefinition[] {
  const tools: ToolDefinition[] = [];
  const history = historyTools(protocol, body);
  const definitions = [
    ...list.parse(body.tools ?? []).map((raw) => ({ raw, discovered: false })),
    ...history.map((raw) => ({ raw, discovered: true })),
  ].flatMap(({ raw, discovered }) =>
    flattenNamespace(raw).map((nested) => ({ raw: nested, discovered })),
  );
  for (const { raw, discovered } of definitions) {
    const tool = decodeToolDefinition(protocol, raw);
    const previous = tools.find((entry) => entry.name === tool.name);
    if (previous) {
      if (discovered && canonicalJSON(previous) === canonicalJSON(tool)) continue;
      throw unsupported();
    }
    tools.push(tool);
  }
  if (new Set(tools.map((tool) => tool.name)).size !== tools.length) throw unsupported();
  return tools;
}
function decodeToolChoice(body: Record<string, unknown>): ModelInput["toolChoice"] | undefined {
  const choice = body.tool_choice;
  if (typeof choice === "string") return z.enum(["auto", "none", "required"]).parse(choice);
  if (!choice) return;
  const selected = object.parse(choice);
  if (selected.type === "any") return "required";
  if (selected.type === "auto" || selected.type === "none") return selected.type;
  return { type: "tool", toolName: string(selected.name ?? object.parse(selected.function).name) };
}

/** The message list under construction, with the tool calls a result may answer. */
class Transcript {
  readonly messages: ModelMessage[] = [];
  private readonly calls = new Map<string, string>();
  push(message: ModelMessage): void {
    this.messages.push(message);
  }
  appendCall(id: string, name: string, input: unknown): void {
    this.calls.set(id, name);
    this.messages.push({
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: id, toolName: name, input }],
    });
  }
  appendResult(id: string, value: unknown, failed = false): void {
    const name = this.calls.get(id);
    if (!name) throw unsupported();
    this.messages.push({
      role: "tool",
      content: [
        { type: "tool-result", toolCallId: id, toolName: name, output: toolOutput(value, failed) },
      ],
    });
  }
}
const roleSchema = z.enum(["user", "assistant", "system"]);
/** `developer` is the Responses spelling of a system message. */
function decodeRole(role: unknown): "user" | "assistant" | "system" {
  return role === "developer" ? "system" : roleSchema.parse(role);
}
function decodeResponsesItem(item: Record<string, unknown>, transcript: Transcript): void {
  if (item.type === "tool_search_call")
    transcript.appendCall(string(item.call_id), "tool_search", item.arguments);
  else if (item.type === "tool_search_output")
    transcript.appendResult(string(item.call_id), JSON.stringify(item.tools));
  else if (item.type === "function_call" || item.type === "custom_tool_call")
    transcript.appendCall(
      string(item.call_id),
      item.namespace ? `${string(item.namespace)}__${string(item.name)}` : string(item.name),
      item.type === "custom_tool_call"
        ? { input: string(item.input) }
        : JSON.parse(string(item.arguments)),
    );
  else if (item.type === "function_call_output" || item.type === "custom_tool_call_output")
    transcript.appendResult(string(item.call_id), item.output);
  else if (item.type === "reasoning") {
    // Encrypted reasoning is opaque to other providers; native passthrough preserves it.
    if (item.encrypted_content) throw unsupported();
    const summary = list
      .parse(item.summary ?? [])
      .map((part) => string(part.text))
      .join("\n");
    if (summary)
      transcript.push({ role: "assistant", content: [{ type: "reasoning", text: summary }] });
  } else {
    if (item.type && item.type !== "message") throw unsupported();
    const role = decodeRole(item.role);
    if (role === "user") transcript.push({ role, content: userContent(item.content) });
    else transcript.push({ role, content: text(item.content) });
  }
}
function decodeResponsesInput(body: Record<string, unknown>, transcript: Transcript): void {
  if (body.instructions) transcript.push({ role: "system", content: string(body.instructions) });
  const items =
    typeof body.input === "string"
      ? [{ role: "user", content: body.input }]
      : list.parse(body.input);
  for (const item of items) decodeResponsesItem(item, transcript);
}
/** One content part of a Chat Completions or Messages API message. */
function decodeMessagePart(
  role: "user" | "assistant" | "system",
  part: Record<string, unknown>,
  transcript: Transcript,
): void {
  if (part.type === "tool_use")
    transcript.appendCall(string(part.id), string(part.name), part.input);
  else if (part.type === "tool_result")
    transcript.appendResult(string(part.tool_use_id), part.content, part.is_error === true);
  else if (part.type === "text") transcript.push({ role, content: string(part.text) });
  else if (role === "user" && ["image", "image_url"].includes(string(part.type)))
    transcript.push({ role, content: [image(part)] });
  else if (role === "assistant" && part.type === "thinking")
    transcript.push({ role, content: [{ type: "reasoning", text: string(part.thinking) }] });
  else throw unsupported();
}
function decodeChatMessage(message: Record<string, unknown>, transcript: Transcript): void {
  if (message.role === "tool") {
    transcript.appendResult(string(message.tool_call_id), message.content);
    return;
  }
  const role = decodeRole(message.role);
  if (typeof message.content === "string") transcript.push({ role, content: message.content });
  else if (message.content)
    for (const part of list.parse(message.content)) decodeMessagePart(role, part, transcript);
  if (role === "assistant" && typeof message.reasoning_content === "string")
    transcript.push({ role, content: [{ type: "reasoning", text: message.reasoning_content }] });
  for (const call of list.parse(message.tool_calls ?? [])) {
    const fn = object.parse(call.function);
    transcript.appendCall(string(call.id), string(fn.name), JSON.parse(string(fn.arguments)));
  }
}
function decodeChatMessages(body: Record<string, unknown>, transcript: Transcript): void {
  if (body.system) transcript.push({ role: "system", content: text(body.system) });
  for (const message of list.parse(body.messages)) decodeChatMessage(message, transcript);
}

export async function decodeModelRequest(request: Request): Promise<ModelInput> {
  const protocol = protocolFor(new URL(request.url).pathname);
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
  output.tools = decodeTools(protocol, body);
  const toolChoice = decodeToolChoice(body);
  if (toolChoice !== undefined) output.toolChoice = toolChoice;
  const transcript = new Transcript();
  if (protocol === "responses") decodeResponsesInput(body, transcript);
  else decodeChatMessages(body, transcript);
  output.messages = transcript.messages;
  return output;
}
