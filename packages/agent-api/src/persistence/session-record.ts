import { Schema } from "effect";
import type { AgentOutputItem as UpstreamOutputItem } from "openai/resources/beta/agents/agents";
import type { SessionArtifact } from "openai/resources/beta/agents/sessions/artifacts";

import type { EnvironmentSpec } from "../environments.js";
import { InvalidSessionState } from "../errors.js";
import type { AgentConfig, AgentSession, InputMessage, JsonWire } from "../protocol.js";
import {
  type Checkpoint,
  type Execution,
  executionSchema,
  type RuntimeCommand,
} from "../runtime.js";

/** The durable shape of one session and the helpers that keep it well formed. */
interface SessionBase {
  readonly schemaVersion?: 2;
  readonly tenant: string;
  readonly session: Readonly<AgentSession>;
  readonly agent: AgentConfig;
  readonly driver: string;
  readonly revision: string;
  readonly model: string;
  readonly generation: number;
  readonly checkpoint: Checkpoint | null;
  readonly cursor: number;
  readonly deleted: boolean;
  readonly environmentSpec?: EnvironmentSpec;
  /** Set by a fork whose native history could not be carried; consumed by the next completed turn. */
  readonly inheritedTranscript?: string;
  readonly forkedFrom?: { sessionId: string; turnId: string | null };
}
/** The persisted shape is unchanged; impossible phase/execution pairs are unrepresentable. */
const executionState = Schema.Union(
  Schema.Struct({ phase: Schema.Literal("idle", "failed"), execution: Schema.Null }),
  Schema.Struct({
    phase: Schema.Literal("starting", "running", "checkpointing"),
    execution: executionSchema,
  }),
);
export type SessionRecord = SessionBase & typeof executionState.Type;
export type ActiveSession = Extract<SessionRecord, { execution: Execution }>;
export interface ArtifactRecord extends SessionArtifact {
  key: string;
}
export interface Command {
  id: string;
  turnId: string;
  command: RuntimeCommand;
  /** Input items added for a steer; removed if the executor never received the steer. */
  itemIds?: string[];
}
/** Steer input the executor rejected after the fact; it runs as the next turn. */
export interface QueuedInput {
  input: InputMessage[];
}
/** The public shape of an item the native runtime streams; a subset of `AgentSessionItem`. */
export type OutputItem = JsonWire<UpstreamOutputItem>;
/** A streamed native item's public index and current shape, keyed by `${turnId}:${nativeId}`. */
export interface OutputPosition {
  index: number;
  item: OutputItem;
}

export function migrate(record: SessionRecord): SessionRecord {
  if (record.schemaVersion === 2) return record;
  if (record.schemaVersion !== undefined)
    throw new InvalidSessionState({ reason: "Unsupported session record version" });
  // Alpha records stored the response-only null limit in request configuration.
  const agent = (config: AgentConfig): AgentConfig => ({
    ...config,
    ...(config.multi_agent
      ? {
          multi_agent: {
            enabled: config.multi_agent.enabled,
            ...(config.multi_agent.max_concurrent_subagents != null
              ? { max_concurrent_subagents: config.multi_agent.max_concurrent_subagents }
              : {}),
          },
        }
      : {}),
  });
  const base = { ...record, schemaVersion: 2 as const, agent: agent(record.agent) };
  return record.execution
    ? {
        ...base,
        phase: record.phase,
        execution: { ...record.execution, agent: agent(record.execution.agent) },
      }
    : { ...base, phase: record.phase, execution: null };
}
export function validate(record: SessionRecord): void {
  if (
    !Schema.is(executionState)(record) ||
    (record.execution &&
      (record.execution.generation !== record.generation ||
        record.execution.sessionId !== record.session.id))
  )
    throw new InvalidSessionState({ reason: "Persisted execution state is inconsistent" });
}
