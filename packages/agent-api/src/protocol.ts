import { Data } from "effect";
import type {
  Agent as UpstreamAgent,
  AgentSessionEvent as UpstreamEvent,
  AgentSessionItem as UpstreamItem,
  AgentSession as UpstreamSession,
} from "openai/resources/beta/agents/agents";
import { z } from "zod";

export type { Turn } from "openai/resources/beta/agents/sessions/turns";

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

/** Expected validation failures cross DO RPC as data, without platform error logs. */
export type RpcResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      error: { status: ApiError["status"]; code: string; message: string };
    };
export function rpcFailure(error: unknown): RpcResult<never> {
  if (!(error instanceof ApiError)) throw error;
  return { ok: false, error: { status: error.status, code: error.code, message: error.message } };
}
export function unwrap<T>(result: RpcResult<T>): T {
  if (result.ok) return result.value;
  throw new ApiError(result.error.status, result.error.code, result.error.message);
}

export const metadataSchema = z
  .record(z.string().max(64), z.string().max(512))
  .refine((value) => Object.keys(value).length <= 16, "At most 16 metadata entries")
  .nullable()
  .optional();
export const functionToolSchema = z.strictObject({
  type: z.literal("function"),
  name: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/),
  description: z.string(),
  parameters: z.record(z.string(), z.json()),
  defer_loading: z.literal(false).optional(),
});
export const agentConfigSchema = z.strictObject({
  model: z.string().min(1).max(200),
  instructions: z.string().max(128_000).nullable().optional(),
  tools: z
    .array(functionToolSchema)
    .max(64)
    .refine(
      (tools) => new Set(tools.map((tool) => tool.name)).size === tools.length,
      "Tool names must be unique",
    )
    .nullable()
    .optional(),
  multi_agent: z
    .strictObject({ enabled: z.literal(false), max_concurrent_subagents: z.null().optional() })
    .nullable()
    .optional(),
});
export const savedAgentSchema = agentConfigSchema.extend({
  name: z.string().max(256).nullable().optional(),
  metadata: metadataSchema,
});
export const inputMessageSchema = z.strictObject({
  type: z.literal("message").optional(),
  role: z.literal("user"),
  content: z
    .array(z.strictObject({ type: z.literal("input_text"), text: z.string().max(128_000) }))
    .min(1),
});
export const createSessionSchema = z.strictObject({
  environment: z.discriminatedUnion("type", [
    z.strictObject({ type: z.literal("none") }),
    z.strictObject({ type: z.literal("openai_hosted") }),
  ]),
  agent: agentConfigSchema.partial().optional(),
  agent_id: z.string().optional(),
  input: z
    .union([z.string().min(1).max(128_000), z.array(inputMessageSchema).min(1)])
    .nullable()
    .optional(),
  metadata: metadataSchema,
  stream: z.boolean().optional(),
  vault_ids: z.array(z.never()).optional(),
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
    output: z.string().max(1_000_000).nullable().optional(),
    error: z.string().nullable().optional(),
  }),
]);
export const eventsSchema = z.strictObject({ events: z.array(inputEventSchema).min(1).max(32) });
export const pageSchema = z.strictObject({
  after: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  order: z.enum(["asc", "desc"]).default("desc"),
});
export type AgentConfig = z.infer<typeof agentConfigSchema>;
export type CreateSession = z.infer<typeof createSessionSchema>;
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

export function inputMessages(input: NonNullable<CreateSession["input"]>): InputMessage[] {
  return typeof input === "string"
    ? [{ role: "user", content: [{ type: "input_text", text: input }] }]
    : input;
}
