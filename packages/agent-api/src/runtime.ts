import { z } from "zod";
import type { AgentConfig, InputMessage } from "./protocol.js";
import { agentConfigSchema, inputMessageSchema } from "./protocol.js";

export const checkpointSchema = z.strictObject({
  version: z.literal(1),
  driver: z.string(),
  revision: z.string(),
  native: z.string(),
  workspace: z
    .strictObject({ id: z.string(), dir: z.string(), localBucket: z.boolean().optional() })
    .optional(),
});
export const executionSchema = z.strictObject({
  sessionId: z.string().regex(/^sess_[a-zA-Z0-9]+$/),
  turnId: z.string().regex(/^turn_[a-zA-Z0-9]+$/),
  generation: z.number().int().positive(),
  harness: z.string(),
  model: z.string(),
  agent: agentConfigSchema,
  input: z.array(inputMessageSchema),
  checkpoint: checkpointSchema.nullable(),
  deadline: z.number(),
  sandbox: z.boolean(),
});
export const commandSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("cancel") }),
  z.strictObject({ type: z.literal("steer"), input: z.array(inputMessageSchema) }),
  z.strictObject({
    type: z.literal("tool_result"),
    callId: z.string(),
    success: z.boolean(),
    output: z.string(),
  }),
]);

/** Serialized across a Service Binding or the Container supervisor boundary. */
export interface Execution {
  sessionId: string;
  turnId: string;
  generation: number;
  harness: string;
  model: string;
  agent: AgentConfig;
  input: InputMessage[];
  checkpoint: Checkpoint | null;
  deadline: number;
  sandbox: boolean;
}

export interface Checkpoint {
  version: 1;
  driver: string;
  revision: string;
  native: string;
  workspace?: { id: string; dir: string; localBucket?: boolean };
}

export const runtimeEventSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("text"),
    id: z.string(),
    text: z.string(),
    phase: z.enum(["commentary", "final_answer"]),
  }),
  z.strictObject({ type: z.literal("delta"), id: z.string(), text: z.string() }),
  z.strictObject({
    type: z.literal("function_call"),
    id: z.string(),
    callId: z.string(),
    name: z.string(),
    arguments: z.json(),
  }),
  z.strictObject({
    type: z.literal("command"),
    id: z.string(),
    command: z.string(),
    output: z.string(),
    exitCode: z.number().nullable(),
  }),
]);
export type RuntimeEvent = z.infer<typeof runtimeEventSchema>;
export interface RuntimeBatch {
  events: { seq: number; event: RuntimeEvent }[];
  cursor: number;
  status: "running" | "waiting" | "completed" | "cancelled" | "failed" | "missing";
  error?: string;
}
export const batchSchema = z.strictObject({
  events: z.array(z.strictObject({ seq: z.number().int().positive(), event: runtimeEventSchema })),
  cursor: z.number().int().min(0),
  status: z.enum(["running", "waiting", "completed", "cancelled", "failed", "missing"]),
  error: z.string().optional(),
});
export type RuntimeCommand =
  | { type: "steer"; input: InputMessage[] }
  | { type: "cancel" }
  | { type: "tool_result"; callId: string; success: boolean; output: string };

/**
 * Implementations must deduplicate start/control by operationId. A missing job
 * after an acknowledged start means outcome_unknown, never permission to replay.
 */
export interface RuntimeDriver {
  readonly name: string;
  readonly revision: string;
  readonly capabilities: { steer: boolean; functions: boolean; sandbox: boolean };
  start(execution: Execution, operationId: string): Promise<void>;
  poll(execution: Execution, after: number): Promise<RuntimeBatch>;
  control(execution: Execution, operationId: string, command: RuntimeCommand): Promise<void>;
  checkpoint(execution: Execution): Promise<Checkpoint>;
  stop(execution: Execution): Promise<void>;
}

export interface AgentRegistration {
  harness: string;
  model: string;
}

export interface ServiceOptions<Env> {
  /** Deploy-owned names are persisted, never JavaScript provider instances. */
  agents: Record<string, AgentRegistration>;
  harnesses: (env: Env) => Record<string, RuntimeDriver>;
  /** HTTP authentication resolves a tenant; Service Binding callers supply it directly. */
  authenticate: (request: Request, env: Env) => Promise<string | null>;
  maxTurnMs?: number;
  pollIntervalMs?: number;
}
