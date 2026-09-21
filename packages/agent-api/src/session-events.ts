import type { Subagent, TokenUsage } from "openai/resources/beta/agents/agents";

import { InvalidRuntimeEvent } from "./errors.js";
import type { Kind } from "./persistence/kind.js";
import { eachRecord, type RecordStore } from "./persistence/record-store.js";
import { SessionKinds } from "./persistence/session-kinds.js";
import type {
  ActiveSession,
  Fenced,
  OutputItem,
  OutputPosition,
  SessionRecord,
} from "./persistence/session-record.js";
import type { SessionTx } from "./persistence/session-tx.js";
import type { AgentSessionEvent, AgentSessionItem, InputEvent, Turn } from "./protocol.js";
import { identifier } from "./protocol.js";
import type { RuntimeEvent } from "./runtime.js";

/** A runtime event naming state this session never created is a protocol violation, not a retry. */
function runtimeRecord<T>(store: RecordStore, kind: Kind<T>, id: string): T {
  const value = store.get(kind, id);
  if (!value)
    throw new InvalidRuntimeEvent({
      code: "invalid_runtime_event",
      message: `Runtime event references an unknown ${kind}: ${id}`,
    });
  return value;
}
type AssistantMessage = Extract<OutputItem, { type: "message" }>;

type Event<T extends RuntimeEvent["type"]> = Extract<RuntimeEvent, { type: T }>;
/** Every runtime event that describes one streamed output item of a turn. */
type ItemEvent = Exclude<RuntimeEvent, { type: "subagent" | "subagent_turn" | "usage" }>;

/**
 * Called inside the SessionDO transition transaction, on the fenced record. Emits no
 * network I/O. Subagent and usage events update their own records; every other event
 * is one streamed output item, resolved to its public position once and then applied by
 * kind.
 */
export function acceptRuntimeEvent(
  tx: SessionTx,
  record: Fenced<ActiveSession>,
  event: RuntimeEvent,
): Fenced<ActiveSession> {
  switch (event.type) {
    case "subagent":
      return acceptSubagent(tx, record, event);
    case "subagent_turn":
      return acceptSubagentTurn(tx, record, event);
    case "usage":
      return acceptUsage(tx, record, event);
    default:
      return acceptOutputItem(tx, record, event);
  }
}

// --- Subagents and usage ----------------------------------------------------------------

function subagentEventType(
  previous: Subagent | undefined,
  subagent: Subagent,
):
  | "agent.session.subagent.created"
  | "agent.session.subagent.closed"
  | "agent.session.subagent.active" {
  if (!previous) return "agent.session.subagent.created";
  return subagent.status === "closed"
    ? "agent.session.subagent.closed"
    : "agent.session.subagent.active";
}
function acceptSubagent(
  tx: SessionTx,
  record: Fenced<ActiveSession>,
  event: Event<"subagent">,
): Fenced<ActiveSession> {
  const db = tx.store;
  const previous = db.get(SessionKinds.subagent, event.id);
  const subagent: Subagent = {
    id: event.id,
    object: "agent.session.subagent",
    session_id: record.session.id,
    parent_agent_id: event.parentId ?? record.session.agent.id,
    name: event.name ?? previous?.name ?? null,
    instructions:
      event.instructions === null
        ? (previous?.instructions ?? null)
        : [{ type: "output_text", text: event.instructions }],
    status: event.status,
    opened_at: previous?.opened_at ?? event.openedAt,
    closed_at: event.status === "closed" ? Math.floor(Date.now() / 1000) : null,
  };
  db.put(SessionKinds.subagent, event.id, subagent);
  if (!previous || previous.status !== subagent.status)
    db.append({
      type: subagentEventType(previous, subagent),
      event_id: identifier("evt"),
      subagent,
    } satisfies AgentSessionEvent);
  return record;
}
function acceptSubagentTurn(
  tx: SessionTx,
  record: Fenced<ActiveSession>,
  event: Event<"subagent_turn">,
): Fenced<ActiveSession> {
  const db = tx.store;
  runtimeRecord(db, SessionKinds.subagent, event.subagentId);
  const previous = tx.turn(event.id);
  const turn: Turn = {
    id: event.id,
    object: "agent.session.turn",
    session_id: record.session.id,
    agent_id: event.subagentId,
    subagent_id: event.subagentId,
    created_at: previous?.created_at ?? event.startedAt,
    started_at: event.startedAt,
    completed_at: event.completedAt,
    status: event.status,
    error: null,
    usage: previous?.usage ?? null,
  };
  if (event.status === "completed") {
    // Child history belongs to the root checkpoint. Publish completion only
    // after that checkpoint commits, even when Codex finished the child early.
    db.put(SessionKinds.pendingSubagentTurn, turn.id, turn);
    if (!previous) tx.putTurn({ ...turn, status: "in_progress", completed_at: null });
    return record;
  }
  tx.putTurn(turn);
  const context = {
    event_id: identifier("evt"),
    session_id: record.session.id,
    turn_id: turn.id,
    turn,
  };
  if (!previous)
    db.append({ ...context, type: "agent.session.turn.created" } satisfies AgentSessionEvent);
  if (event.status === "in_progress")
    db.append({
      ...context,
      event_id: identifier("evt"),
      type: "agent.session.turn.in_progress",
    } satisfies AgentSessionEvent);
  else if (event.status !== "waiting") {
    finishOutputItems(tx, record, turn.id, SessionKinds.subagentItem(event.subagentId));
    db.append({
      ...context,
      event_id: identifier("evt"),
      type: `agent.session.turn.${event.status}`,
      usage: turn.usage,
    } satisfies AgentSessionEvent);
  }
  return record;
}
function acceptUsage(
  tx: SessionTx,
  record: Fenced<ActiveSession>,
  event: Event<"usage">,
): Fenced<ActiveSession> {
  const db = tx.store;
  const turnId = event.turnId ?? record.execution.turnId;
  const turn = runtimeRecord(db, SessionKinds.turn, turnId);
  const previous = turn.usage;
  const total = record.session.usage;
  const add = (current: number | undefined, next: number, old: number | undefined) =>
    Math.max(0, (current ?? 0) + next - (old ?? 0));
  const usage: TokenUsage = {
    input_tokens: add(total?.input_tokens, event.usage.input_tokens, previous?.input_tokens),
    output_tokens: add(total?.output_tokens, event.usage.output_tokens, previous?.output_tokens),
    total_tokens: add(total?.total_tokens, event.usage.total_tokens, previous?.total_tokens),
    input_tokens_details: {
      cached_tokens: add(
        total?.input_tokens_details.cached_tokens,
        event.usage.input_tokens_details.cached_tokens,
        previous?.input_tokens_details.cached_tokens,
      ),
    },
    output_tokens_details: {
      reasoning_tokens: add(
        total?.output_tokens_details.reasoning_tokens,
        event.usage.output_tokens_details.reasoning_tokens,
        previous?.output_tokens_details.reasoning_tokens,
      ),
    },
  };
  tx.putTurn({ ...turn, usage: event.usage });
  const pending = db.get(SessionKinds.pendingSubagentTurn, turnId);
  if (pending) db.put(SessionKinds.pendingSubagentTurn, turnId, { ...pending, usage: event.usage });
  return { ...record, session: { ...record.session, usage } };
}

// --- Output items -----------------------------------------------------------------------

/**
 * One streamed native item resolved to its public position: the id and output index it
 * had before (or fresh ones), the partition it is stored in, and the writes every kind
 * of item shares.
 */
interface ItemSlot {
  readonly db: RecordStore;
  readonly turnId: string;
  readonly kind: Kind<AgentSessionItem>;
  readonly previous: OutputPosition | undefined;
  readonly id: string;
  readonly index: number;
  readonly context: { readonly session_id: string; readonly turn_id: string };
  /** Store the item under its partition and its native position. */
  readonly save: (item: OutputItem) => void;
  /** Claim the next output index and publish `item.added`. */
  readonly added: (item: OutputItem) => void;
  readonly emit: (event: AgentSessionEvent) => void;
}
function resolveSlot(db: RecordStore, record: Fenced<ActiveSession>, event: ItemEvent): ItemSlot {
  const turnId = event.turnId ?? record.execution.turnId;
  const kind = event.subagentId ? SessionKinds.subagentItem(event.subagentId) : SessionKinds.item;
  const context = { session_id: record.session.id, turn_id: turnId };
  const previous = db.get(SessionKinds.output, `${turnId}:${event.id}`);
  const id =
    previous?.item.id ??
    identifier(event.type === "text" || event.type === "delta" ? "msg" : "item");
  const index = previous?.index ?? db.get(SessionKinds.outputCount, turnId) ?? 0;
  const emit = (sessionEvent: AgentSessionEvent) => {
    db.append(sessionEvent);
  };
  return {
    db,
    turnId,
    kind,
    previous,
    id,
    index,
    context,
    emit,
    save: (item) => {
      db.put(kind, item.id, item);
      db.put(SessionKinds.output, `${turnId}:${event.id}`, {
        index,
        item,
      } satisfies OutputPosition);
    },
    added: (item) => {
      db.put(SessionKinds.outputCount, turnId, index + 1);
      emit({
        ...context,
        event_id: identifier("evt"),
        type: "agent.session.turn.item.added",
        item,
        output_index: index,
      });
    },
  };
}
const itemDone = (slot: ItemSlot, item: OutputItem) => {
  slot.emit({
    ...slot.context,
    event_id: identifier("evt"),
    type: "agent.session.turn.item.done",
    item,
    output_index: slot.index,
  });
};
function acceptOutputItem(
  tx: SessionTx,
  record: Fenced<ActiveSession>,
  event: ItemEvent,
): Fenced<ActiveSession> {
  const slot = resolveSlot(tx.store, record, event);
  switch (event.type) {
    case "collaboration":
      acceptCollaboration(slot, record, event);
      return record;
    case "delta":
    case "text":
      acceptMessage(slot, event);
      return record;
    case "reasoning":
    case "reasoning_delta":
    case "reasoning_part":
      acceptReasoning(slot, event);
      return record;
    case "command_start":
    case "command_delta":
      acceptCommandStream(slot, event);
      return record;
    case "web_search":
      acceptWebSearch(slot, event);
      return record;
    case "function_call":
      return acceptFunctionCall(tx, slot, record, event);
    default:
      acceptCompletedItem(slot, event);
      return record;
  }
}

type CollaborationItem = Extract<
  OutputItem,
  {
    type:
      | "create_subagent_call"
      | "wait_for_subagents_call"
      | "close_subagent_call"
      | "resume_subagent_call"
      | "interrupt_subagent_call"
      | "send_subagent_input_call";
  }
>;
function collaborationItem(
  slot: ItemSlot,
  record: Fenced<ActiveSession>,
  event: Event<"collaboration">,
): CollaborationItem {
  const base = {
    id: slot.id,
    turn_id: slot.turnId,
    status: event.success ? ("completed" as const) : ("failed" as const),
  };
  const sender = event.subagentId ?? record.session.agent.id;
  const recipient = event.recipients[0] ?? "";
  const content =
    event.prompt === null ? [] : [{ type: "output_text" as const, text: event.prompt }];
  switch (event.operation) {
    case "spawnAgent":
      return {
        ...base,
        type: "create_subagent_call",
        agent_id: sender,
        content,
        model: event.model,
        reasoning_effort: event.effort,
      };
    case "wait":
      return {
        ...base,
        type: "wait_for_subagents_call",
        sender_agent_id: sender,
        recipient_agent_ids: [...event.recipients],
      };
    case "closeAgent":
      return {
        ...base,
        type: "close_subagent_call",
        sender_agent_id: sender,
        recipient_agent_id: recipient,
      };
    case "resumeAgent":
      return {
        ...base,
        type: "resume_subagent_call",
        sender_agent_id: sender,
        recipient_agent_id: recipient,
      };
    case "interruptAgent":
      return {
        ...base,
        type: "interrupt_subagent_call",
        sender_agent_id: sender,
        recipient_agent_id: recipient,
      };
    default:
      return {
        ...base,
        type: "send_subagent_input_call",
        sender_agent_id: sender,
        recipient_agent_id: recipient,
        content,
      };
  }
}
function acceptCollaboration(
  slot: ItemSlot,
  record: Fenced<ActiveSession>,
  event: Event<"collaboration">,
): void {
  const item = collaborationItem(slot, record, event);
  if (!slot.previous) slot.added(item);
  slot.save(item);
  itemDone(slot, item);
}
function acceptMessage(slot: ItemSlot, event: Event<"delta" | "text">): void {
  const { previous, index, context, emit } = slot;
  const item: AssistantMessage =
    previous?.item.type === "message"
      ? previous.item
      : {
          id: slot.id,
          type: "message",
          role: "assistant",
          turn_id: slot.turnId,
          status: "in_progress",
          phase: event.type === "text" ? event.phase : null,
          content: [{ type: "output_text", text: "" }],
        };
  if (!previous) {
    slot.added(item);
    emit({
      ...context,
      event_id: identifier("evt"),
      type: "agent.session.turn.content_part.added",
      item_id: item.id,
      output_index: index,
      content_index: 0,
      part: { type: "output_text", text: "" },
    });
  }
  if (event.type === "delta") {
    item.content = [{ type: "output_text", text: (item.content[0]?.text ?? "") + event.text }];
    emit({
      ...context,
      event_id: identifier("evt"),
      type: "agent.session.turn.output_text.delta",
      item_id: item.id,
      output_index: index,
      content_index: 0,
      delta: event.text,
    });
  } else {
    if (!previous)
      emit({
        ...context,
        event_id: identifier("evt"),
        type: "agent.session.turn.output_text.delta",
        item_id: item.id,
        output_index: index,
        content_index: 0,
        delta: event.text,
      });
    item.content = [{ type: "output_text", text: event.text }];
    item.phase = event.phase;
    item.status = "completed";
    emit({
      ...context,
      event_id: identifier("evt"),
      type: "agent.session.turn.output_text.done",
      item_id: item.id,
      output_index: index,
      content_index: 0,
      text: event.text,
    });
    emit({
      ...context,
      event_id: identifier("evt"),
      type: "agent.session.turn.content_part.done",
      item_id: item.id,
      output_index: index,
      content_index: 0,
      part: { type: "output_text", text: event.text },
    });
    itemDone(slot, item);
  }
  slot.save(item);
}
type ReasoningItem = Extract<OutputItem, { type: "reasoning" }>;
function acceptReasoning(
  slot: ItemSlot,
  event: Event<"reasoning" | "reasoning_delta" | "reasoning_part">,
): void {
  const { previous, index, context, emit } = slot;
  const item: ReasoningItem =
    previous?.item.type === "reasoning"
      ? previous.item
      : {
          id: slot.id,
          type: "reasoning",
          turn_id: slot.turnId,
          status: "in_progress",
          summary: [],
        };
  if (!previous) slot.added(item);
  const partContext = { ...context, item_id: item.id, output_index: index };
  const ensurePart = (summaryIndex: number) => {
    while (item.summary.length <= summaryIndex) {
      const part = { type: "summary_text" as const, text: "" };
      const position = item.summary.length;
      item.summary.push(part);
      emit({
        ...partContext,
        event_id: identifier("evt"),
        type: "agent.session.turn.reasoning_summary_part.added",
        summary_index: position,
        part,
      });
    }
  };
  if (event.type === "reasoning_delta" || event.type === "reasoning_part") {
    ensurePart(event.summaryIndex);
    if (event.type === "reasoning_delta") {
      const part = item.summary[event.summaryIndex];
      if (part) part.text += event.text;
      emit({
        ...partContext,
        event_id: identifier("evt"),
        type: "agent.session.turn.reasoning_summary_text.delta",
        summary_index: event.summaryIndex,
        delta: event.text,
      });
    }
  } else {
    for (const [summary_index, text] of event.summary.entries()) {
      ensurePart(summary_index);
      const previousText = item.summary[summary_index]?.text ?? "";
      if (text.startsWith(previousText) && text.length > previousText.length)
        emit({
          ...partContext,
          event_id: identifier("evt"),
          type: "agent.session.turn.reasoning_summary_text.delta",
          summary_index,
          delta: text.slice(previousText.length),
        });
      item.summary[summary_index] = { type: "summary_text", text };
    }
    item.status = event.status;
    if (event.status === "completed") {
      for (const [summary_index, part] of item.summary.entries()) {
        emit({
          ...partContext,
          event_id: identifier("evt"),
          type: "agent.session.turn.reasoning_summary_text.done",
          summary_index,
          text: part.text,
        });
        emit({
          ...partContext,
          event_id: identifier("evt"),
          type: "agent.session.turn.reasoning_summary_part.done",
          summary_index,
          part,
          status: null,
        });
      }
      itemDone(slot, item);
    }
  }
  slot.save(item);
}
type CommandItem = Extract<OutputItem, { type: "command_execution" }>;
function acceptCommandStream(
  slot: ItemSlot,
  event: Event<"command_start" | "command_delta">,
): void {
  const { previous } = slot;
  const item: CommandItem =
    previous?.item.type === "command_execution"
      ? previous.item
      : {
          id: slot.id,
          type: "command_execution",
          turn_id: slot.turnId,
          command: event.type === "command_start" ? event.command : "",
          cwd: event.type === "command_start" ? event.cwd : null,
          duration_ms: null,
          exit_code: null,
          output: "",
          status: "in_progress",
        };
  if (!previous) slot.added(item);
  if (event.type === "command_delta") {
    item.output = (item.output ?? "") + event.text;
    slot.emit({
      ...slot.context,
      event_id: identifier("evt"),
      type: "agent.output.command_execution_output.delta",
      item_id: item.id,
      output_index: slot.index,
      delta: event.text,
    });
  }
  slot.save(item);
}
function acceptWebSearch(slot: ItemSlot, event: Event<"web_search">): void {
  const item: OutputItem = {
    id: slot.id,
    type: "web_search_call",
    turn_id: slot.turnId,
    action:
      event.action?.type === "search"
        ? { ...event.action, queries: event.action.queries ? [...event.action.queries] : null }
        : event.action,
    status: event.status,
  };
  if (!slot.previous) slot.added(item);
  slot.save(item);
  if (event.status !== "in_progress") itemDone(slot, item);
}
/** A finished command's public status when the runtime did not name one. */
function commandStatus(exitCode: number | null): CommandItem["status"] {
  if (exitCode === null) return "incomplete";
  return exitCode === 0 ? "completed" : "failed";
}
function completedItem(slot: ItemSlot, event: Event<"mcp" | "command">): OutputItem {
  if (event.type === "mcp")
    return {
      id: slot.id,
      type: "mcp_call",
      turn_id: slot.turnId,
      name: event.name,
      server_label: event.server,
      arguments: event.arguments,
      output: event.output,
      error: event.error,
      status: event.success ? "completed" : "failed",
    };
  const { previous } = slot;
  return {
    id: slot.id,
    type: "command_execution",
    turn_id: slot.turnId,
    command: event.command,
    cwd: event.cwd ?? (previous?.item.type === "command_execution" ? previous.item.cwd : null),
    duration_ms: event.durationMs ?? null,
    exit_code: event.exitCode,
    output: event.output,
    status: event.status ?? commandStatus(event.exitCode),
  };
}
/** An MCP call or a finished command: stored, positioned and published done in one step. */
function acceptCompletedItem(slot: ItemSlot, event: Event<"mcp" | "command">): void {
  const item = completedItem(slot, event);
  if (!slot.previous) slot.added(item);
  slot.save(item);
  itemDone(slot, item);
}
/** A function call is published done and then parks the session on the client's answer. */
function acceptFunctionCall(
  tx: SessionTx,
  slot: ItemSlot,
  record: Fenced<ActiveSession>,
  event: Event<"function_call">,
): Fenced<ActiveSession> {
  const item: OutputItem = {
    id: slot.id,
    type: "function_call",
    turn_id: slot.turnId,
    call_id: event.callId,
    name: event.name,
    arguments: event.arguments,
    status: "completed",
  };
  if (!slot.previous) slot.added(item);
  slot.save(item);
  itemDone(slot, item);
  const required_actions = record.session.required_actions.some(
    (action) => action.type === "function_call" && action.call_id === event.callId,
  )
    ? record.session.required_actions
    : [
        ...record.session.required_actions,
        {
          type: "function_call" as const,
          turn_id: slot.turnId,
          call_id: event.callId,
          name: event.name,
          arguments: event.arguments,
        },
      ];
  const next: Fenced<ActiveSession> = {
    ...record,
    session: { ...record.session, required_actions, status: "requires_action" },
  };
  const turn = runtimeRecord(slot.db, SessionKinds.turn, slot.turnId);
  turn.status = "waiting";
  tx.putTurn(turn);
  slot.emit({
    type: "agent.session.requires_action",
    event_id: identifier("evt"),
    session: next.session,
  });
  return next;
}

export function recordToolResult(
  tx: SessionTx,
  record: SessionRecord,
  event: Extract<InputEvent, { type: "agent.session.input.tool_result" }>,
): void {
  const item: AgentSessionItem = {
    id: identifier("output"),
    type: "function_call_output",
    turn_id: event.turn_id,
    call_id: event.call_id,
    status: event.success ? "completed" : "failed",
    output: event.output ?? null,
    error: event.error ?? null,
  };
  const turn = tx.requireTurn(event.turn_id);
  tx.store.put(
    turn.subagent_id ? SessionKinds.subagentItem(turn.subagent_id) : SessionKinds.item,
    item.id ?? identifier("output"),
    item,
  );
  tx.emit({
    type: "agent.session.turn.item.added",
    event_id: identifier("evt"),
    session_id: record.session.id,
    turn_id: event.turn_id,
    item,
    output_index: null,
  } satisfies AgentSessionEvent);
}

/** Close partial streamed output before publishing a terminal turn, including cancellation. */
export function finishOutputItems(
  tx: SessionTx,
  record: Fenced<ActiveSession>,
  turnId: string,
  itemKind: Kind<AgentSessionItem>,
): void {
  const db = tx.store;
  for (const { index, item } of eachRecord(db, SessionKinds.output, {
    field: "item.turn_id",
    value: turnId,
  })) {
    if (item.status !== "in_progress") continue;
    item.status = "incomplete";
    db.put(itemKind, item.id, item);
    const key = db.outputKey(item.id);
    if (key) db.put(SessionKinds.output, key, { index, item } satisfies OutputPosition);
    const context = {
      session_id: record.session.id,
      turn_id: turnId,
      item_id: item.id,
      output_index: index,
    };
    if (item.type === "reasoning") {
      for (const [summary_index, part] of item.summary.entries()) {
        db.append({
          ...context,
          event_id: identifier("evt"),
          type: "agent.session.turn.reasoning_summary_text.done",
          summary_index,
          text: part.text,
        } satisfies AgentSessionEvent);
        db.append({
          ...context,
          event_id: identifier("evt"),
          type: "agent.session.turn.reasoning_summary_part.done",
          summary_index,
          part,
          status: "incomplete",
        } satisfies AgentSessionEvent);
      }
    } else if (item.type === "message") {
      for (const [content_index, part] of item.content.entries()) {
        db.append({
          ...context,
          event_id: identifier("evt"),
          type: "agent.session.turn.output_text.done",
          content_index,
          text: part.text,
        } satisfies AgentSessionEvent);
        db.append({
          ...context,
          event_id: identifier("evt"),
          type: "agent.session.turn.content_part.done",
          content_index,
          part,
        } satisfies AgentSessionEvent);
      }
    }
    db.append({
      session_id: record.session.id,
      turn_id: turnId,
      event_id: identifier("evt"),
      type: "agent.session.turn.item.done",
      item,
      output_index: index,
    } satisfies AgentSessionEvent);
  }
}
