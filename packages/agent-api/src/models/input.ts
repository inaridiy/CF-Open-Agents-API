import type { ModelMessage } from "ai";
import { z } from "zod";
import { ApiError } from "../protocol.js";

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
  }[];
  toolChoice?: "auto" | "none" | "required" | { type: "tool"; toolName: string };
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
}

const object = z.record(z.string(), z.unknown());
const list = z.array(object);
const unsupported = () =>
  new ApiError(
    400,
    "unsupported_model_input",
    "The translated gateway supports text and function tools; use a native model preset for provider-specific content",
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
  if (
    body.previous_response_id ||
    body.background ||
    body.store === true ||
    (body.output_config && object.parse(body.output_config).format) ||
    body.response_format
  )
    throw unsupported();
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
  };
  const definitions = list
    .parse(body.tools ?? [])
    .flatMap((raw) =>
      raw.type === "namespace"
        ? list.parse(raw.tools).map((tool) => ({ ...tool, namespace: string(raw.name) }))
        : [raw],
    );
  for (const raw of definitions) {
    const definition = protocol === "chat-completions" ? object.parse(raw.function) : raw;
    const custom = raw.type === "custom";
    if (protocol !== "anthropic" && raw.type !== "function" && !custom) throw unsupported();
    output.tools.push({
      name: raw.namespace
        ? `${string(raw.namespace)}__${string(definition.name)}`
        : string(definition.name),
      wireName: string(definition.name),
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
    });
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
          output: { type: failed ? "error-text" : "text", value: text(value) },
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
      if (item.type === "function_call" || item.type === "custom_tool_call")
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
        output.messages.push({ role, content: text(item.content) });
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
          else throw unsupported();
        }
      }
      for (const call of list.parse(message.tool_calls ?? [])) {
        const fn = object.parse(call.function);
        appendCall(string(call.id), string(fn.name), JSON.parse(string(fn.arguments)));
      }
    }
  }
  return output;
}
