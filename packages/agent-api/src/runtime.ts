import { type Effect, Schema } from "effect";
import { io, type ServiceError } from "./effect.js";
import type { AgentConfig, InputMessage, JsonValue } from "./protocol.js";
import { agentConfigSchema, inputMessageSchema } from "./protocol.js";

// These two wire contracts also feed MCP/Zod APIs. Validate them at the interop boundary.
const agentConfig = Schema.declare<AgentConfig>(
  (input): input is AgentConfig => agentConfigSchema.safeParse(input).success,
);
const inputMessage = Schema.declare<InputMessage>(
  (input): input is InputMessage => inputMessageSchema.safeParse(input).success,
);
const json: Schema.Schema<JsonValue> = Schema.suspend(() =>
  Schema.Union(
    Schema.String,
    Schema.JsonNumber,
    Schema.Boolean,
    Schema.Null,
    Schema.mutable(Schema.Array(json)),
    Schema.mutable(Schema.Record({ key: Schema.String, value: json })),
  ),
);
export const checkpointSchema = Schema.Struct({
  version: Schema.Literal(1),
  driver: Schema.String,
  revision: Schema.String,
  native: Schema.String,
  workspace: Schema.optional(
    Schema.Struct({
      id: Schema.String,
      dir: Schema.String,
      localBucket: Schema.optional(Schema.Boolean),
    }),
  ),
});
export const executionSchema = Schema.Struct({
  sessionId: Schema.String.pipe(Schema.pattern(/^sess_[a-zA-Z0-9]+$/)),
  turnId: Schema.String.pipe(Schema.pattern(/^turn_[a-zA-Z0-9]+$/)),
  generation: Schema.Int.pipe(Schema.positive()),
  harness: Schema.String,
  model: Schema.String,
  agent: agentConfig,
  input: Schema.mutable(Schema.Array(inputMessage)),
  checkpoint: Schema.NullOr(checkpointSchema),
  deadline: Schema.Number.pipe(Schema.finite()),
  sandbox: Schema.Boolean,
});
export const commandSchema = Schema.Union(
  Schema.Struct({ type: Schema.Literal("cancel") }),
  Schema.Struct({
    type: Schema.Literal("steer"),
    input: Schema.mutable(Schema.Array(inputMessage)),
  }),
  Schema.Struct({
    type: Schema.Literal("tool_result"),
    callId: Schema.String,
    success: Schema.Boolean,
    output: Schema.String,
  }),
);
export const runtimeEventSchema = Schema.Union(
  Schema.Struct({
    type: Schema.Literal("text"),
    id: Schema.String,
    text: Schema.String,
    phase: Schema.Literal("commentary", "final_answer"),
  }),
  Schema.Struct({ type: Schema.Literal("delta"), id: Schema.String, text: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("function_call"),
    id: Schema.String,
    callId: Schema.String,
    name: Schema.String,
    arguments: json,
  }),
  Schema.Struct({
    type: Schema.Literal("command"),
    id: Schema.String,
    command: Schema.String,
    output: Schema.String,
    exitCode: Schema.NullOr(Schema.Number),
  }),
);
export const batchSchema = Schema.Struct({
  events: Schema.mutable(
    Schema.Array(
      Schema.Struct({ seq: Schema.Int.pipe(Schema.positive()), event: runtimeEventSchema }),
    ),
  ),
  cursor: Schema.NonNegativeInt,
  status: Schema.Literal("running", "waiting", "completed", "cancelled", "failed", "missing"),
  error: Schema.optional(Schema.String),
});

/** Serialized across Service Bindings and Container HTTP. Types come from the decoders. */
export type Execution = typeof executionSchema.Type;
export type Checkpoint = typeof checkpointSchema.Type;
export type RuntimeCommand = typeof commandSchema.Type;
export type RuntimeEvent = typeof runtimeEventSchema.Type;
export type RuntimeBatch = typeof batchSchema.Type;

/**
 * Implementations must deduplicate start/control by operationId. A missing job
 * after an acknowledged start means outcome_unknown, never permission to replay.
 */
export interface RuntimeDriver {
  readonly name: string;
  readonly revision: string;
  readonly capabilities: { steer: boolean; functions: boolean; sandbox: boolean };
  start(execution: Execution, operationId: string): Effect.Effect<void, ServiceError>;
  poll(execution: Execution, after: number): Effect.Effect<RuntimeBatch, ServiceError>;
  control(
    execution: Execution,
    operationId: string,
    command: RuntimeCommand,
  ): Effect.Effect<void, ServiceError>;
  checkpoint(execution: Execution): Effect.Effect<Checkpoint, ServiceError>;
  stop(execution: Execution): Effect.Effect<void, ServiceError>;
}

/** Migration adapter for external Promise drivers. All calls are lazy and typed. */
export type PromiseRuntimeDriver = {
  [K in keyof RuntimeDriver]: RuntimeDriver[K] extends (
    ...args: infer P
  ) => Effect.Effect<infer A, ServiceError>
    ? (...args: P) => Promise<A>
    : RuntimeDriver[K];
};
export const fromPromiseDriver = (driver: PromiseRuntimeDriver): RuntimeDriver => ({
  name: driver.name,
  revision: driver.revision,
  capabilities: driver.capabilities,
  start: (execution, id) => io("runtime.start", () => driver.start(execution, id)),
  poll: (execution, after) => io("runtime.poll", () => driver.poll(execution, after)),
  control: (execution, id, command) =>
    io("runtime.control", () => driver.control(execution, id, command)),
  checkpoint: (execution) => io("runtime.checkpoint", () => driver.checkpoint(execution)),
  stop: (execution) => io("runtime.stop", () => driver.stop(execution)),
});

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
