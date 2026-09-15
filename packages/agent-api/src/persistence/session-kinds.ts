import type { AgentSessionEnvironmentState, Subagent } from "openai/resources/beta/agents/agents";

import type { AgentSessionItem, Turn } from "../protocol.js";
import { kind } from "./kind.js";
import type {
  ArtifactRecord,
  Command,
  OutputPosition,
  QueuedInput,
  SessionRecord,
} from "./session-record.js";

/**
 * Every record kind a session object stores. The strings are the persisted table
 * partition and never change; the types are what each partition holds. Two singletons
 * share the `state` partition under different ids, so they are two typed views of it.
 */
export const SessionKinds = {
  /** id `session`: the session record. */
  state: kind<SessionRecord>("state"),
  /** id `tombstone`: what a purged object keeps so a deletion retry still answers. */
  tombstone: kind<{ id: string }>("state"),
  /** id `status`: the last environment status this session published. */
  environment: kind<AgentSessionEnvironmentState["status"]>("environment"),
  /** Idempotency key to the fingerprint of the input it accepted. */
  idempotency: kind<string>("idempotency"),
  turn: kind<Turn>("turn"),
  /** Completed child turns published only once the root checkpoint commits. */
  pendingSubagentTurn: kind<Turn>("pending_subagent_turn"),
  item: kind<AgentSessionItem>("item"),
  subagentItem: (subagentId: string) => kind<AgentSessionItem>(`subagent_item:${subagentId}`),
  subagent: kind<Subagent>("subagent"),
  artifact: kind<ArtifactRecord>("artifact"),
  /** Queued steer and tool-result deliveries, in acceptance order. */
  command: kind<Command>("command"),
  /** id = turn id: at most one cancellation per turn, kept until the outcome is durable. */
  cancellation: kind<Command>("cancellation"),
  queuedInput: kind<QueuedInput>("queued_input"),
  /** id `${turnId}:${nativeId}`: the public index and shape of a streamed native item. */
  output: kind<OutputPosition>("output"),
  /** id = turn id: how many output positions the turn has assigned. */
  outputCount: kind<number>("output_count"),
} as const;
