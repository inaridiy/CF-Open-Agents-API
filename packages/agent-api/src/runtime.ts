import { type Effect, Schema } from "effect";

import { io, type ServiceError } from "./effect.js";
import type { EnvironmentDriver } from "./environments.js";
import type { AgentConfig, InputMessage, JsonValue } from "./protocol.js";
import { agentConfigSchema, functionOutputSchema, inputMessageSchema } from "./protocol.js";

// These two wire contracts also feed MCP/Zod APIs. Validate them at the interop boundary.
const agentConfig = Schema.declare<AgentConfig>(
  (input): input is AgentConfig => agentConfigSchema.safeParse(input).success,
);
const inputMessage = Schema.declare<InputMessage>(
  (input): input is InputMessage => inputMessageSchema.safeParse(input).success,
);
const functionOutput = Schema.declare<ReturnType<typeof functionOutputSchema.parse>>(
  (input): input is ReturnType<typeof functionOutputSchema.parse> =>
    functionOutputSchema.safeParse(input).success,
);
const usageSchema = Schema.Struct({
  input_tokens: Schema.NonNegativeInt,
  output_tokens: Schema.NonNegativeInt,
  total_tokens: Schema.NonNegativeInt,
  input_tokens_details: Schema.Struct({ cached_tokens: Schema.NonNegativeInt }),
  output_tokens_details: Schema.Struct({ reasoning_tokens: Schema.NonNegativeInt }),
});
const eventScope = {
  subagentId: Schema.optional(Schema.String),
  turnId: Schema.optional(Schema.String),
};
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
  artifacts: Schema.optional(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        key: Schema.String,
        created_at: Schema.Number,
        environment_id: Schema.String,
        session_id: Schema.String,
        turn_id: Schema.String,
        path: Schema.String,
        size_bytes: Schema.Number,
      }),
    ),
  ),
  environmentFileVersion: Schema.optional(Schema.NonNegativeInt),
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
  environmentId: Schema.optional(Schema.String),
  capabilityRoots: Schema.optional(Schema.Array(Schema.String)),
  tenant: Schema.optional(Schema.String),
  vaultIds: Schema.optional(Schema.Array(Schema.String)),
  /** Deployment presets this turn may delegate to; present only when subagents are enabled. */
  delegates: Schema.optional(
    Schema.Array(
      Schema.Struct({ alias: Schema.String, harness: Schema.String, model: Schema.String }),
    ),
  ),
  maxConcurrentSubagents: Schema.optional(Schema.Int.pipe(Schema.positive())),
  /** Set on a delegated child: it shares the parent's sandbox and is never checkpointed. */
  parent: Schema.optional(Schema.Struct({ turnId: Schema.String, subagentId: Schema.String })),
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
    output: functionOutput,
  }),
);
export const runtimeEventSchema = Schema.Union(
  Schema.Struct({
    type: Schema.Literal("usage"),
    id: Schema.String,
    /** Cumulative usage within this turn, excluding preceding turns. */
    usage: usageSchema,
    ...eventScope,
  }),
  Schema.Struct({
    type: Schema.Literal("reasoning"),
    id: Schema.String,
    summary: Schema.Array(Schema.String),
    status: Schema.Literal("in_progress", "completed"),
    ...eventScope,
  }),
  Schema.Struct({
    type: Schema.Literal("reasoning_delta"),
    id: Schema.String,
    summaryIndex: Schema.NonNegativeInt,
    text: Schema.String,
    ...eventScope,
  }),
  Schema.Struct({
    type: Schema.Literal("reasoning_part"),
    id: Schema.String,
    summaryIndex: Schema.NonNegativeInt,
    text: Schema.String,
    ...eventScope,
  }),
  Schema.Struct({
    type: Schema.Literal("command_start"),
    id: Schema.String,
    command: Schema.String,
    cwd: Schema.NullOr(Schema.String),
    ...eventScope,
  }),
  Schema.Struct({
    type: Schema.Literal("command_delta"),
    id: Schema.String,
    text: Schema.String,
    ...eventScope,
  }),
  Schema.Struct({
    type: Schema.Literal("web_search"),
    id: Schema.String,
    action: Schema.NullOr(
      Schema.Union(
        Schema.Struct({
          type: Schema.Literal("search"),
          query: Schema.NullOr(Schema.String),
          queries: Schema.NullOr(Schema.Array(Schema.String)),
        }),
        Schema.Struct({ type: Schema.Literal("open_page"), url: Schema.NullOr(Schema.String) }),
        Schema.Struct({
          type: Schema.Literal("find_in_page"),
          url: Schema.NullOr(Schema.String),
          pattern: Schema.NullOr(Schema.String),
        }),
        Schema.Struct({ type: Schema.Literal("other") }),
      ),
    ),
    status: Schema.Literal("in_progress", "completed", "incomplete"),
    ...eventScope,
  }),
  Schema.Struct({
    type: Schema.Literal("mcp"),
    id: Schema.String,
    name: Schema.String,
    server: Schema.String,
    arguments: json,
    output: json,
    error: json,
    success: Schema.Boolean,
    subagentId: Schema.optional(Schema.String),
    turnId: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("collaboration"),
    id: Schema.String,
    operation: Schema.Literal(
      "spawnAgent",
      "sendInput",
      "resumeAgent",
      "wait",
      "closeAgent",
      "sendMessage",
      "followupTask",
      "interruptAgent",
    ),
    recipients: Schema.Array(Schema.String),
    prompt: Schema.NullOr(Schema.String),
    model: Schema.NullOr(Schema.String),
    effort: Schema.NullOr(Schema.String),
    success: Schema.Boolean,
    subagentId: Schema.optional(Schema.String),
    turnId: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("subagent"),
    id: Schema.String,
    parentId: Schema.NullOr(Schema.String),
    name: Schema.NullOr(Schema.String),
    instructions: Schema.NullOr(Schema.String),
    status: Schema.Literal("active", "closed"),
    openedAt: Schema.Number,
  }),
  Schema.Struct({
    type: Schema.Literal("subagent_turn"),
    id: Schema.String,
    subagentId: Schema.String,
    status: Schema.Literal("in_progress", "waiting", "completed", "cancelled", "failed"),
    startedAt: Schema.Number,
    completedAt: Schema.NullOr(Schema.Number),
  }),
  Schema.Struct({
    type: Schema.Literal("text"),
    id: Schema.String,
    text: Schema.String,
    phase: Schema.Literal("commentary", "final_answer"),
    subagentId: Schema.optional(Schema.String),
    turnId: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("delta"),
    id: Schema.String,
    text: Schema.String,
    subagentId: Schema.optional(Schema.String),
    turnId: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("function_call"),
    id: Schema.String,
    callId: Schema.String,
    name: Schema.String,
    arguments: json,
    subagentId: Schema.optional(Schema.String),
    turnId: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("command"),
    id: Schema.String,
    command: Schema.String,
    output: Schema.String,
    exitCode: Schema.NullOr(Schema.Number),
    cwd: Schema.optional(Schema.NullOr(Schema.String)),
    durationMs: Schema.optional(Schema.NullOr(Schema.Number)),
    status: Schema.optional(Schema.Literal("completed", "failed", "incomplete")),
    subagentId: Schema.optional(Schema.String),
    turnId: Schema.optional(Schema.String),
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
  readonly capabilities: {
    steer: boolean;
    functions: boolean;
    sandbox: boolean;
    /** Native subagents owned by the runtime, projected as session subagents. */
    subagents?: boolean;
    images?: boolean;
    reasoningSummaries?: boolean;
    usage?: boolean;
    webSearch?: boolean;
    commandOutputDeltas?: boolean;
    programmaticToolCalling?: boolean;
    /** Configured `mcp` tools, including environment-origin servers when a sandbox exists. */
    mcp?: boolean;
    /** `tool_search` and `defer_loading` function tools. */
    toolSearch?: boolean;
    /** Environment skills, plugins and capability directories reach the runtime. */
    environmentCapabilities?: boolean;
    /**
     * The runtime fixes its client tool set when a native thread starts, so a
     * resumed checkpoint cannot gain or lose tools. Forks that change the tool
     * surface then carry a transcript instead of the native checkpoint.
     */
    toolsFixedAtStart?: boolean;
  };
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

/**
 * Migration adapter for external Promise drivers. All calls are lazy and typed. Each
 * method also receives the fiber's interruption signal; a driver that can cancel the
 * underlying call should honor it, and one that cannot may ignore it.
 */
export type PromiseRuntimeDriver = {
  [K in keyof RuntimeDriver]: RuntimeDriver[K] extends (
    ...args: infer P
  ) => Effect.Effect<infer A, ServiceError>
    ? (...args: [...P, signal: AbortSignal]) => Promise<A>
    : RuntimeDriver[K];
};
export const fromPromiseDriver = (driver: PromiseRuntimeDriver): RuntimeDriver => ({
  name: driver.name,
  revision: driver.revision,
  capabilities: driver.capabilities,
  start: (execution, id) => io("runtime.start", (signal) => driver.start(execution, id, signal)),
  poll: (execution, after) => io("runtime.poll", (signal) => driver.poll(execution, after, signal)),
  control: (execution, id, command) =>
    io("runtime.control", (signal) => driver.control(execution, id, command, signal)),
  checkpoint: (execution) =>
    io("runtime.checkpoint", (signal) => driver.checkpoint(execution, signal)),
  stop: (execution) => io("runtime.stop", (signal) => driver.stop(execution, signal)),
});

export interface AgentRegistration {
  harness: string;
  model: string;
  /**
   * Other agent aliases this preset may delegate to when `multi_agent` is enabled.
   * Children run on their own harness and share the parent's execution environment.
   */
  delegates?: string[];
  /**
   * The alias's model connection performs hosted web search (a native Responses or
   * Anthropic passthrough). `web_search` tools are accepted only when both the
   * harness and the alias support it; the portable AI SDK path cannot.
   */
  webSearch?: boolean;
}

export interface ServiceOptions<Env> {
  /** Deploy-owned names are persisted, never JavaScript provider instances. */
  agents: Record<string, AgentRegistration>;
  harnesses: (env: Env) => Record<string, RuntimeDriver>;
  /** HTTP authentication resolves a tenant; Service Binding callers supply it directly. */
  authenticate: (request: Request, env: Env) => Promise<string | null>;
  maxTurnMs?: number;
  pollIntervalMs?: number;
  /** R2 bucket shared with the environment driver for immutable artifacts and input files. */
  objects?: (env: Env) => R2Bucket;
  environments?: (env: Env) => EnvironmentDriver;
}
