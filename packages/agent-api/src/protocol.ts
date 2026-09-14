import { Data } from "effect";
import type {
  Agent as UpstreamAgent,
  AgentSessionEvent as UpstreamEvent,
  AgentSessionItem as UpstreamItem,
  AgentSession as UpstreamSession,
} from "openai/resources/beta/agents/agents";
import { z } from "zod";

import { agentToolSchema, credentialFreeTools, type functionToolSchema } from "./agent-tools.js";
import { hostedConfigurationSchema } from "./environment-config.js";

export type { Turn } from "openai/resources/beta/agents/sessions/turns";
export { functionToolSchema } from "./agent-tools.js";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };
/** OpenAI's `unknown` JSON fields must be JSON values at the Workers RPC boundary. */
export type JsonWire<T> = unknown extends T
  ? string | number | boolean | null | object
  : T extends object
    ? { [K in keyof T]: JsonWire<T[K]> }
    : T;
export type Agent = JsonWire<UpstreamAgent>;
export type AgentSession = JsonWire<UpstreamSession>;
export type AgentSessionEvent = JsonWire<UpstreamEvent>;
export type AgentSessionItem = JsonWire<UpstreamItem>;
export interface ListPage<T> {
  object: "list";
  data: T[];
  has_more: boolean;
  first_id: string | null;
  last_id: string | null;
}

export const COMPATIBILITY = {
  profile: "cf-agents-v1-alpha",
  upstream: "agents=v1",
  openaiSDK: "7.15.0",
  codex: "0.154.0",
} as const;

export class ApiError extends Data.TaggedError("ApiError")<{
  readonly status: 400 | 401 | 404 | 409 | 413 | 422 | 429 | 500 | 503;
  readonly code: string;
  readonly message: string;
}> {
  constructor(
    status: 400 | 401 | 404 | 409 | 413 | 422 | 429 | 500 | 503,
    code: string,
    message: string,
  ) {
    super({ status, code, message });
    // Error name/message survive Workers RPC; custom properties/prototypes do not.
    this.name = `AgentApiError:${status}:${code}`;
  }
}
export function remoteApiError(error: Error): ApiError | undefined {
  if (error instanceof ApiError) return error;
  const match = /^AgentApiError:(400|401|404|409|413|422|429|500|503):([a-z_]+)$/.exec(error.name);
  if (!match?.[1] || !match[2]) return undefined;
  const status = z
    .union([
      z.literal(400),
      z.literal(401),
      z.literal(404),
      z.literal(409),
      z.literal(413),
      z.literal(422),
      z.literal(429),
      z.literal(500),
      z.literal(503),
    ])
    .parse(Number(match[1]));
  return new ApiError(status, match[2], error.message);
}

const WORKSPACE_TOOL_NAMES = new Set(["bash", "read", "write", "edit"]);
const TOOL_SEARCH_NAMES = new Set(["cf_tool_search", "cf_call_tool"]);
export const metadataSchema = z
  .record(z.string().max(64), z.string().max(512))
  .refine((value) => Object.keys(value).length <= 16, "At most 16 metadata entries")
  .nullable()
  .optional();
export const agentConfigSchema = z.strictObject({
  model: z.string().min(1).max(200),
  instructions: z.string().max(128_000).nullable().optional(),
  tools: z
    .array(agentToolSchema)
    .max(64)
    .refine(
      (tools) =>
        new Set(
          tools.map((tool) =>
            tool.type === "function"
              ? tool.name
              : tool.type === "mcp"
                ? `mcp:${tool.server_label}`
                : tool.type,
          ),
        ).size === tools.length,
      "Tool names must be unique",
    )
    .refine(
      (tools) =>
        !tools.some(
          (tool) => tool.type === "programmatic_tool_calling" && tool.enabled !== false,
        ) ||
        !tools.some(
          (tool) =>
            tool.type === "function" &&
            (tool.name === "cf_execute" || WORKSPACE_TOOL_NAMES.has(tool.name)),
        ),
      "Programmatic tools reserve cf_execute and workspace tool names",
    )
    .refine(
      (tools) =>
        !tools.some(
          (tool) => tool.type === "tool_search" || (tool.type === "function" && tool.defer_loading),
        ) || !tools.some((tool) => tool.type === "function" && TOOL_SEARCH_NAMES.has(tool.name)),
      "Deferred tools reserve cf_tool_search and cf_call_tool",
    )
    .nullable()
    .optional(),
  multi_agent: z
    .strictObject({
      enabled: z.boolean(),
      max_concurrent_subagents: z.number().int().positive().optional(),
    })
    .nullable()
    .optional(),
  reasoning: z
    .strictObject({
      effort: z
        .enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"])
        .nullable()
        .optional(),
      summary: z.enum(["concise", "detailed", "auto"]).nullable().optional(),
    })
    .nullable()
    .optional(),
  service_tier: z.enum(["auto", "default", "flex", "priority", "fast"]).nullable().optional(),
  text: z
    .strictObject({
      format: z
        .discriminatedUnion("type", [
          z.strictObject({ type: z.literal("text") }),
          z.strictObject({
            type: z.literal("json_schema"),
            schema: z.record(z.string(), z.json()),
          }),
        ])
        .nullable()
        .optional(),
      verbosity: z.enum(["low", "medium", "high"]).nullable().optional(),
    })
    .nullable()
    .optional(),
});
/** Subagent delegation exposes cf_delegate, cf_wait and cf_close to the runtime. */
export const DELEGATION_TOOL_NAMES = new Set(["cf_delegate", "cf_wait", "cf_close"]);
export function reservedDelegationName(agent: {
  multi_agent?: { enabled: boolean } | null;
  tools?: readonly { type: string; name?: string }[] | null;
}): boolean {
  return (
    !!agent.multi_agent?.enabled &&
    (agent.tools ?? []).some(
      (tool) => tool.type === "function" && DELEGATION_TOOL_NAMES.has(tool.name ?? ""),
    )
  );
}
export const savedAgentSchema = agentConfigSchema.extend({
  tools: agentConfigSchema.shape.tools.refine(
    (tools) => credentialFreeTools(tools ?? []),
    "Reusable agents cannot store credentials; provide credentials when creating a session",
  ),
  name: z.string().max(256).nullable().optional(),
  metadata: metadataSchema,
});
export const inputContentSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("input_text"), text: z.string().max(128_000) }),
  z.strictObject({
    type: z.literal("input_image"),
    image_url: z
      .string()
      .min(1)
      .max(1_000_000)
      .refine((value) => {
        if (/^data:image\/[a-zA-Z0-9.+-]+;base64,[a-zA-Z0-9+/=\r\n]+$/.test(value)) return true;
        try {
          const url = new URL(value);
          return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
        } catch {
          return false;
        }
      }, "Expected an HTTP(S) image URL or a base64 image data URL"),
  }),
]);
export const functionOutputSchema = z.union([
  z.string().max(1_000_000),
  z.array(inputContentSchema).max(100),
]);
export const inputMessageSchema = z.strictObject({
  type: z.literal("message").optional(),
  role: z.literal("user"),
  content: z.array(inputContentSchema).min(1).max(100),
});
export const createSessionSchema = z.strictObject({
  environment: z.discriminatedUnion("type", [
    z.strictObject({ type: z.literal("none") }),
    hostedConfigurationSchema.extend({
      type: z.literal("openai_hosted"),
      environment_template_id: z.string().optional(),
    }),
  ]),
  agent: agentConfigSchema.partial().optional(),
  agent_id: z.string().optional(),
  input: z
    .union([z.string().min(1).max(128_000), z.array(inputMessageSchema).min(1)])
    .nullable()
    .optional(),
  metadata: metadataSchema,
  stream: z.boolean().optional(),
  vault_ids: z.array(z.string().min(1)).max(100).nullable().optional(),
});
/** `/cf/v1` extension: continue a session's committed state in a new session. */
export const forkSessionSchema = z.strictObject({
  agent: agentConfigSchema.partial().optional(),
  input: createSessionSchema.shape.input,
  metadata: metadataSchema,
  vault_ids: createSessionSchema.shape.vault_ids,
});
export const inputEventSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("agent.session.input.message"),
    input: z.array(inputMessageSchema).min(1),
  }),
  z.strictObject({ type: z.literal("agent.session.input.cancel") }),
  z.strictObject({
    type: z.literal("agent.session.input.tool_result"),
    call_id: z.string(),
    turn_id: z.string(),
    success: z.boolean(),
    output: functionOutputSchema.nullable().optional(),
    error: z.string().nullable().optional(),
  }),
]);
export const eventsSchema = z.strictObject({ events: z.array(inputEventSchema).min(1).max(32) });
export const pageSchema = z.strictObject({
  after: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  order: z.enum(["asc", "desc"]).default("desc"),
});
export const sessionPageSchema = pageSchema.extend({ agent_id: z.string().optional() });
export type AgentConfig = z.infer<typeof agentConfigSchema>;
export type CreateSession = z.infer<typeof createSessionSchema>;
export type ForkSession = z.infer<typeof forkSessionSchema>;
export type InputEvent = z.infer<typeof inputEventSchema>;
export type InputMessage = z.infer<typeof inputMessageSchema>;
export type FunctionTool = z.infer<typeof functionToolSchema>;
export type PageQuery = z.infer<typeof pageSchema>;

export function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new ApiError(400, "invalid_request", z.prettifyError(result.error));
  return result.data;
}

export function canonicalJSON(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(",")}]`;
  return `{${Object.entries(value)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJSON(v)}`)
    .join(",")}}`;
}

export function identifier(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

/** Remote images a turn may reference; data URLs travel inline and are not counted. */
export const IMAGE_LIMIT = 256;
export function remoteImageURLs(
  parts: Iterable<{ type: string; image_url?: string }>,
  into = new Set<string>(),
): Set<string> {
  for (const part of parts)
    if (part.type === "input_image" && part.image_url && !part.image_url.startsWith("data:"))
      into.add(part.image_url);
  return into;
}
export function assertImageLimit(urls: ReadonlySet<string>): void {
  if (urls.size > IMAGE_LIMIT)
    throw new ApiError(
      413,
      "image_limit",
      `At most ${IMAGE_LIMIT} distinct remote images per request`,
    );
}
export function inputMessages(input: NonNullable<CreateSession["input"]>): InputMessage[] {
  return typeof input === "string"
    ? [{ role: "user", content: [{ type: "input_text", text: input }] }]
    : input;
}
