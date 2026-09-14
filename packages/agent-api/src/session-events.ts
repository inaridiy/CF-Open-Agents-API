import type {
  Subagent,
  TokenUsage,
  AgentOutputItem as UpstreamOutputItem,
} from "openai/resources/beta/agents/agents";

import { InvalidRuntimeEvent } from "./errors.js";
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
/** A runtime event naming state this session never created is a protocol violation, not a retry. */
function runtimeRecord<T>(db: SqlStore, kind: string, id: string): T {
  const value = db.get<T>(kind, id);
  if (!value)
    throw new InvalidRuntimeEvent({
      code: "invalid_runtime_event",
      message: `Runtime event references an unknown ${kind}: ${id}`,
    });
  return value;
}
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
  if (event.type === "subagent") {
    const previous = db.get<Subagent>("subagent", event.id);
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
    db.put("subagent", event.id, subagent);
    if (!previous || previous.status !== subagent.status)
      db.append({
        type: !previous
          ? "agent.session.subagent.created"
          : subagent.status === "closed"
            ? "agent.session.subagent.closed"
            : "agent.session.subagent.active",
        event_id: identifier("evt"),
        subagent,
      } satisfies AgentSessionEvent);
    return record;
  }
  if (event.type === "subagent_turn") {
    runtimeRecord<Subagent>(db, "subagent", event.subagentId);
    const previous = db.get<Turn>("turn", event.id);
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
      db.put("pending_subagent_turn", turn.id, turn);
      if (!previous)
        db.put("turn", turn.id, { ...turn, status: "in_progress", completed_at: null });
      return record;
    }
    db.put("turn", turn.id, turn);
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
      finishOutputItems(db, record, turn.id, `subagent_item:${event.subagentId}`);
      db.append({
        ...context,
        event_id: identifier("evt"),
        type: `agent.session.turn.${event.status}`,
        usage: turn.usage,
      } satisfies AgentSessionEvent);
    }
    return record;
  }
  const turnId = event.turnId ?? record.execution.turnId;
  if (event.type === "usage") {
    const turn = runtimeRecord<Turn>(db, "turn", turnId);
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
    db.put("turn", turnId, { ...turn, usage: event.usage });
    const pending = db.get<Turn>("pending_subagent_turn", turnId);
    if (pending) db.put("pending_subagent_turn", turnId, { ...pending, usage: event.usage });
    return { ...record, session: { ...record.session, usage } };
  }
  const itemKind = event.subagentId ? `subagent_item:${event.subagentId}` : "item";
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
    db.put(itemKind, item.id, item);
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
  if (event.type === "collaboration") {
    const base = {
      id: itemId,
      turn_id: turnId,
      status: event.success ? ("completed" as const) : ("failed" as const),
    };
    const sender = event.subagentId ?? record.session.agent.id;
    const recipient = event.recipients[0] ?? "";
    const content =
      event.prompt === null ? [] : [{ type: "output_text" as const, text: event.prompt }];
    const item: OutputItem =
      event.operation === "spawnAgent"
        ? {
            ...base,
            type: "create_subagent_call",
            agent_id: sender,
            content,
            model: event.model,
            reasoning_effort: event.effort,
          }
        : event.operation === "wait"
          ? {
              ...base,
              type: "wait_for_subagents_call",
              sender_agent_id: sender,
              recipient_agent_ids: [...event.recipients],
            }
          : event.operation === "closeAgent" ||
              event.operation === "resumeAgent" ||
              event.operation === "interruptAgent"
            ? {
                ...base,
                type:
                  event.operation === "closeAgent"
                    ? "close_subagent_call"
                    : event.operation === "resumeAgent"
                      ? "resume_subagent_call"
                      : "interrupt_subagent_call",
                sender_agent_id: sender,
                recipient_agent_id: recipient,
              }
            : {
                ...base,
                type: "send_subagent_input_call",
                sender_agent_id: sender,
                recipient_agent_id: recipient,
                content,
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
    return record;
  }
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
  if (
    event.type === "reasoning" ||
    event.type === "reasoning_delta" ||
    event.type === "reasoning_part"
  ) {
    const item: Extract<OutputItem, { type: "reasoning" }> =
      previous?.item.type === "reasoning"
        ? previous.item
        : { id: itemId, type: "reasoning", turn_id: turnId, status: "in_progress", summary: [] };
    if (!previous) added(item);
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
        emit({
          ...context,
          event_id: identifier("evt"),
          type: "agent.session.turn.item.done",
          item,
          output_index: index,
        });
      }
    }
    save(item);
    return record;
  }
  if (event.type === "command_start" || event.type === "command_delta") {
    const item: Extract<OutputItem, { type: "command_execution" }> =
      previous?.item.type === "command_execution"
        ? previous.item
        : {
            id: itemId,
            type: "command_execution",
            turn_id: turnId,
            command: event.type === "command_start" ? event.command : "",
            cwd: event.type === "command_start" ? event.cwd : null,
            duration_ms: null,
            exit_code: null,
            output: "",
            status: "in_progress",
          };
    if (!previous) added(item);
    if (event.type === "command_delta") {
      item.output = (item.output ?? "") + event.text;
      emit({
        ...context,
        event_id: identifier("evt"),
        type: "agent.output.command_execution_output.delta",
        item_id: item.id,
        output_index: index,
        delta: event.text,
      });
    }
    save(item);
    return record;
  }
  if (event.type === "web_search") {
    const item: OutputItem = {
      id: itemId,
      type: "web_search_call",
      turn_id: turnId,
      action:
        event.action?.type === "search"
          ? { ...event.action, queries: event.action.queries ? [...event.action.queries] : null }
          : event.action,
      status: event.status,
    };
    if (!previous) added(item);
    save(item);
    if (event.status !== "in_progress")
      emit({
        ...context,
        event_id: identifier("evt"),
        type: "agent.session.turn.item.done",
        item,
        output_index: index,
      });
    return record;
  }
  const item: OutputItem =
    event.type === "mcp"
      ? {
          id: itemId,
          type: "mcp_call",
          turn_id: turnId,
          name: event.name,
          server_label: event.server,
          arguments: event.arguments,
          output: event.output,
          error: event.error,
          status: event.success ? "completed" : "failed",
        }
      : event.type === "function_call"
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
            cwd:
              event.cwd ?? (previous?.item.type === "command_execution" ? previous.item.cwd : null),
            duration_ms: event.durationMs ?? null,
            exit_code: event.exitCode,
            output: event.output,
            status:
              event.status ??
              (event.exitCode === null
                ? "incomplete"
                : event.exitCode === 0
                  ? "completed"
                  : "failed"),
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
    const turn = runtimeRecord<Turn>(db, "turn", turnId);
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
  const turn = db.require<Turn>("turn", event.turn_id);
  db.put(
    turn.subagent_id ? `subagent_item:${turn.subagent_id}` : "item",
    item.id ?? identifier("output"),
    item,
  );
  db.append({
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
  db: SqlStore,
  record: ActiveSession,
  turnId: string,
  itemKind: string,
): void {
  let after: string | undefined;
  do {
    const page = db.list<OutputPosition>(
      "output",
      { order: "asc", limit: 100, after },
      { field: "item.turn_id", value: turnId },
    );
    for (const { index, item } of page.data) {
      if (item.status !== "in_progress") continue;
      item.status = "incomplete";
      db.put(itemKind, item.id, item);
      const key = db.outputKey(item.id);
      if (key) db.put("output", key, { index, item } satisfies OutputPosition);
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
    after = page.has_more ? (page.last_id ?? undefined) : undefined;
  } while (after);
}
