import type { JsonValue, RuntimeEvent } from "cf-open-agents-api";

type Event<T extends RuntimeEvent["type"]> = Extract<RuntimeEvent, { type: T }>;
/**
 * Attribution of an event raised on behalf of a subagent turn. Both fields are
 * optional here so a `ToolScope` and Codex's `Origin["scope"]` both fit.
 */
export type Attribution = { subagentId?: string; turnId?: string };

/** Protocol timestamps are whole seconds since the epoch. */
export const nowSeconds = (): number => Math.floor(Date.now() / 1000);
/**
 * An identifier the protocol only compares for equality: a readable prefix and a
 * UUID without its hyphens, so the whole id stays a single word.
 */
export const randomId = (prefix: string): string =>
  `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;

/** What every `subagent` record of one child carries, while it runs and once it is closed. */
export interface SubagentRecord {
  readonly id: string;
  /** Null for a direct child of this turn; the parent's subagent id for a grandchild. */
  readonly parentId?: string | null;
  readonly name: string | null;
  readonly instructions?: string | null;
  readonly openedAt: number;
}
/** The child record while the child may still act. */
export const openSubagent = (child: SubagentRecord): Event<"subagent"> => ({
  type: "subagent",
  id: child.id,
  parentId: child.parentId ?? null,
  name: child.name,
  instructions: child.instructions ?? null,
  openedAt: child.openedAt,
  status: "active",
});
/** The same record sealed: a closed child keeps every field it was opened with. */
export const closeSubagent = (child: SubagentRecord): Event<"subagent"> => ({
  ...openSubagent(child),
  status: "closed",
});

/** A child turn's identity and start, shared by its opening and its settlement. */
export interface SubagentTurnRecord {
  readonly id: string;
  readonly subagentId: string;
  readonly startedAt: number;
}
/** A status a child turn never transitions out of. */
export type SettledTurnStatus = Exclude<
  Event<"subagent_turn">["status"],
  "in_progress" | "waiting"
>;
/** A child turn in whatever state its runtime reports, timestamps included. */
export const subagentTurn = (
  turn: SubagentTurnRecord & {
    readonly status: Event<"subagent_turn">["status"];
    readonly completedAt: number | null;
  },
): Event<"subagent_turn"> => ({
  type: "subagent_turn",
  id: turn.id,
  subagentId: turn.subagentId,
  status: turn.status,
  startedAt: turn.startedAt,
  completedAt: turn.completedAt,
});
/** The child's turn as it opens: in progress, with no completion time yet. */
export const openSubagentTurn = (turn: SubagentTurnRecord): Event<"subagent_turn"> =>
  subagentTurn({ ...turn, status: "in_progress", completedAt: null });
/** The child's turn as it settles; the runtime reports no completion time of its own. */
export const closeSubagentTurn = (
  turn: SubagentTurnRecord & { readonly status: SettledTurnStatus },
): Event<"subagent_turn"> => subagentTurn({ ...turn, completedAt: nowSeconds() });

/** Token counts as a runtime reports them, before the protocol's own field names. */
export interface TokenCounts {
  readonly input: number;
  readonly output: number;
  readonly cached: number;
  readonly reasoning: number;
  /** The provider's own total; the sum of `input` and `output` when it reports none. */
  readonly total?: number;
}
/** Cumulative usage of one turn, under the id the turn reports it against. */
export const usageEvent = (
  id: string,
  tokens: TokenCounts,
  scope?: Attribution,
): Event<"usage"> => ({
  ...scope,
  type: "usage",
  id,
  usage: {
    input_tokens: tokens.input,
    output_tokens: tokens.output,
    total_tokens: tokens.total ?? tokens.input + tokens.output,
    input_tokens_details: { cached_tokens: tokens.cached },
    output_tokens_details: { reasoning_tokens: tokens.reasoning },
  },
});

/**
 * Raise a client function call. The caller owns what it waits on: `ToolJob` keeps a
 * `Deferred<ToolResult>` in the job-wide pending map, Codex a `Deferred<JsonValue>`
 * of its own, and the Codex app-server path holds only the request id.
 */
export const functionCall = (
  callId: string,
  name: string,
  args: JsonValue,
  scope?: Attribution,
): Event<"function_call"> => ({
  ...scope,
  type: "function_call",
  id: callId,
  callId,
  name,
  arguments: args,
});
