import type { AgentOutputItem as UpstreamOutputItem } from "openai/resources/beta/agents/agents";
import type {
  AgentSessionEvent,
  AgentSessionItem,
  InputEvent,
  JsonWire,
  Turn,
} from "./protocol.js";
import { identifier } from "./protocol.js";
import type { RuntimeEvent } from "./runtime.js";
import type { ActiveSession, SessionRecord } from "./session.js";
import type { SqlStore } from "./storage.js";

type OutputItem = JsonWire<UpstreamOutputItem>;
type AssistantMessage = Extract<OutputItem, { type: "message" }>;
interface OutputPosition {
  index: number;
  item: OutputItem;
}

/** Called inside the SessionDO transition transaction. Emits no network I/O. */
export function acceptRuntimeEvent(
  db: SqlStore,
  record: ActiveSession,
  event: RuntimeEvent,
): ActiveSession {
  const turnId = record.execution.turnId;
  const context = { session_id: record.session.id, turn_id: turnId };
  const emit = (event: AgentSessionEvent) => {
    db.append(event);
  };
  const previous = db.get<OutputPosition>("output", `${turnId}:${event.id}`);
  const itemId =
    previous?.item.id ??
    identifier(event.type === "text" || event.type === "delta" ? "msg" : "item");
  const index = previous?.index ?? db.get<number>("output_count", turnId) ?? 0;
  const save = (item: OutputItem) => {
    db.put("item", item.id, item);
    db.put("output", `${turnId}:${event.id}`, { index, item } satisfies OutputPosition);
  };
  const added = (item: OutputItem) => {
    db.put("output_count", turnId, index + 1);
    emit({
      ...context,
      event_id: identifier("evt"),
      type: "agent.session.turn.item.added",
      item,
      output_index: index,
    });
  };
  if (event.type === "delta" || event.type === "text") {
    const item: AssistantMessage =
      previous?.item.type === "message"
        ? previous.item
        : {
            id: itemId,
            type: "message",
            role: "assistant",
            turn_id: turnId,
            status: "in_progress",
            phase: event.type === "text" ? event.phase : null,
            content: [{ type: "output_text", text: "" }],
          };
    if (!previous) {
      added(item);
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
      emit({
        ...context,
        event_id: identifier("evt"),
        type: "agent.session.turn.item.done",
        item,
        output_index: index,
      });
    }
    save(item);
    return record;
  }
  const item: OutputItem =
    event.type === "function_call"
      ? {
          id: itemId,
          type: "function_call",
          turn_id: turnId,
          call_id: event.callId,
          name: event.name,
          arguments: event.arguments,
          status: "completed",
        }
      : {
          id: itemId,
          type: "command_execution",
          turn_id: turnId,
          command: event.command,
          cwd: "/workspace",
          duration_ms: null,
          exit_code: event.exitCode,
          output: event.output,
          status: event.exitCode === 0 ? "completed" : "failed",
        };
  if (!previous) added(item);
  save(item);
  emit({
    ...context,
    event_id: identifier("evt"),
    type: "agent.session.turn.item.done",
    item,
    output_index: index,
  });
  if (event.type === "function_call") {
    const required_actions = record.session.required_actions.some(
      (action) => action.type === "function_call" && action.call_id === event.callId,
    )
      ? record.session.required_actions
      : [
          ...record.session.required_actions,
          {
            type: "function_call" as const,
            turn_id: turnId,
            call_id: event.callId,
            name: event.name,
            arguments: event.arguments,
          },
        ];
    const next: ActiveSession = {
      ...record,
      session: { ...record.session, required_actions, status: "requires_action" },
    };
    const turn = db.require<Turn>("turn", turnId);
    turn.status = "waiting";
    db.put("turn", turnId, turn);
    emit({
      type: "agent.session.requires_action",
      event_id: identifier("evt"),
      session: next.session,
    });
    return next;
  }
  return record;
}

export function recordToolResult(
  db: SqlStore,
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
  db.put("item", item.id ?? identifier("output"), item);
  db.append({
    type: "agent.session.turn.item.added",
    event_id: identifier("evt"),
    session_id: record.session.id,
    turn_id: event.turn_id,
    item,
    output_index: null,
  } satisfies AgentSessionEvent);
}
