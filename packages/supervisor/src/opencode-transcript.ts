import type { AssistantMessage, Event, Part, Session, ToolPart } from "@opencode-ai/sdk/v2/types";
import type { RuntimeEvent } from "cf-open-agents-api";

export type EventScope = { subagentId: string; turnId: string };
export interface ChildState {
  readonly sessionId: string;
  readonly subagentId: string;
  readonly turnId: string;
  readonly openedAt: number;
  name: string | null;
  closed: boolean;
}
/** What the transcript needs from the job whose turn it projects. */
export interface TranscriptHost {
  /** The parent OpenCode session. */
  readonly sessionId: string;
  /** The public turn id usage is reported under. */
  readonly turnId: string;
  /** Native subagent sessions, shared with the job's tool routing. */
  readonly children: Map<string, ChildState>;
  emit(event: RuntimeEvent): void;
  trackTool(part: ToolPart): void;
  /** An assistant message of the parent session answered this user message. */
  answered(userMessageId: string): void;
  /** A `session.updated` echoed this feed barrier token. */
  echoed(token: string): void;
  /** The feed reported the parent session idle. */
  idle(): void;
  diagnostics(line: string): void;
}

/**
 * Projects one public turn from OpenCode's event feed: usage per session, child
 * sessions as subagents, reasoning and text parts, and the deferral of completed
 * text until its step finishes, when a step that ended with tool calls makes its
 * text commentary and a final step makes it the answer. It holds the per-turn
 * maps and touches the job only through `TranscriptHost`.
 */
export class OpenCodeTranscript {
  private readonly started = Date.now();
  private readonly usage = new Map<string, AssistantMessage>();
  private readonly childUsage = new Map<string, Map<string, AssistantMessage>>();
  private readonly parts = new Map<string, Part["type"]>();
  /** Completed text parts wait for their step to finish so their phase is known. */
  private readonly pendingText = new Map<
    string,
    { id: string; text: string; scope?: EventScope }[]
  >();
  private readonly emittedText = new Set<string>();
  constructor(private readonly host: TranscriptHost) {}

  /** Remembers an assistant message of this turn for the usage report; false for another turn's. */
  record(info: AssistantMessage): boolean {
    if (info.sessionID !== this.host.sessionId || info.time.created < this.started) return false;
    this.usage.set(info.id, info);
    return true;
  }
  /** The usage of every recorded inference of the parent session, or of the given messages. */
  publishUsage(messages: Iterable<AssistantMessage> = this.usage.values(), scope?: EventScope) {
    const list = [...messages];
    const input = list.reduce(
      (sum, message) =>
        sum + message.tokens.input + message.tokens.cache.read + message.tokens.cache.write,
      0,
    );
    const output = list.reduce(
      (sum, message) => sum + message.tokens.output + message.tokens.reasoning,
      0,
    );
    this.host.emit({
      type: "usage",
      id: `usage:${scope?.turnId ?? this.host.turnId}`,
      usage: {
        input_tokens: input,
        output_tokens: output,
        total_tokens: input + output,
        input_tokens_details: {
          cached_tokens: list.reduce((sum, message) => sum + message.tokens.cache.read, 0),
        },
        output_tokens_details: {
          reasoning_tokens: list.reduce((sum, message) => sum + message.tokens.reasoning, 0),
        },
      },
      ...scope,
    });
  }
  /** Marks a text part as announced; false when it already was. */
  claim(partId: string): boolean {
    if (this.emittedText.has(partId)) return false;
    this.emittedText.add(partId);
    return true;
  }
  flushText(messageId: string, phase: "commentary" | "final_answer"): void {
    for (const entry of this.pendingText.get(messageId) ?? []) {
      if (!this.claim(entry.id)) continue;
      this.host.emit({ type: "text", id: entry.id, text: entry.text, phase, ...entry.scope });
    }
    this.pendingText.delete(messageId);
  }
  /** Every text still waiting for its step is the answer: the turn is over. */
  flushAll(): void {
    for (const messageId of Array.from(this.pendingText.keys()))
      this.flushText(messageId, "final_answer");
  }
  closeChildren(): void {
    for (const child of this.host.children.values()) this.closeChild(child, "completed");
  }
  private phaseOf(finish: string): "commentary" | "final_answer" {
    return finish.includes("tool") ? "commentary" : "final_answer";
  }
  private scopeOf(sessionId: string): EventScope | undefined {
    if (sessionId === this.host.sessionId) return undefined;
    const child = this.host.children.get(sessionId);
    return child ? { subagentId: child.subagentId, turnId: child.turnId } : undefined;
  }
  private openChild(info: Session): void {
    if (!info.parentID || info.parentID !== this.host.sessionId) return;
    const existing = this.host.children.get(info.id);
    if (existing) {
      if (info.title && existing.name !== info.title) existing.name = info.title;
      return;
    }
    const suffix = info.id.replace(/[^a-zA-Z0-9]/g, "");
    const child: ChildState = {
      sessionId: info.id,
      subagentId: `subagent_${suffix}`,
      turnId: `turn_${suffix}`,
      openedAt: Math.floor((info.time?.created ?? Date.now()) / 1000),
      name: info.title || null,
      closed: false,
    };
    this.host.children.set(info.id, child);
    this.host.emit({
      type: "subagent",
      id: child.subagentId,
      parentId: null,
      name: child.name,
      instructions: null,
      openedAt: child.openedAt,
      status: "active",
    });
    this.host.emit({
      type: "subagent_turn",
      id: child.turnId,
      subagentId: child.subagentId,
      status: "in_progress",
      startedAt: child.openedAt,
      completedAt: null,
    });
  }
  private closeChild(child: ChildState, status: "completed" | "failed"): void {
    if (child.closed) return;
    child.closed = true;
    for (const messageId of Array.from(this.pendingText.keys()))
      if (this.pendingText.get(messageId)?.some((entry) => entry.scope?.turnId === child.turnId))
        this.flushText(messageId, "final_answer");
    this.host.emit({
      type: "subagent_turn",
      id: child.turnId,
      subagentId: child.subagentId,
      status,
      startedAt: child.openedAt,
      completedAt: Math.floor(Date.now() / 1000),
    });
    this.host.emit({
      type: "subagent",
      id: child.subagentId,
      parentId: null,
      name: child.name,
      instructions: null,
      openedAt: child.openedAt,
      status: "closed",
    });
  }
  private collectPart(part: Part): void {
    const scope = this.scopeOf(part.sessionID);
    if (part.sessionID !== this.host.sessionId && !scope) return;
    this.parts.set(part.id, part.type);
    if (part.type === "tool") this.host.trackTool(part);
    if (part.type === "reasoning")
      this.host.emit({
        type: "reasoning",
        id: part.id,
        summary: [part.text],
        status: part.time.end ? "completed" : "in_progress",
        ...scope,
      });
    if (part.type === "text" && part.time?.end && !this.emittedText.has(part.id)) {
      const pending = this.pendingText.get(part.messageID) ?? [];
      if (!pending.some((entry) => entry.id === part.id))
        pending.push({ id: part.id, text: part.text, ...(scope ? { scope } : {}) });
      this.pendingText.set(part.messageID, pending);
    }
    // A step that ends with tool calls makes its text commentary; a final step answers.
    if (part.type === "step-finish") this.flushText(part.messageID, this.phaseOf(part.reason));
  }
  private onAssistantMessage(info: AssistantMessage): void {
    const scope = this.scopeOf(info.sessionID);
    if (info.sessionID === this.host.sessionId) {
      this.host.answered(info.parentID);
      if (this.record(info)) this.publishUsage();
    } else if (scope) {
      const list = this.childUsage.get(info.sessionID) ?? new Map<string, AssistantMessage>();
      list.set(info.id, info);
      this.childUsage.set(info.sessionID, list);
      this.publishUsage(list.values(), scope);
    }
    if (
      (info.sessionID === this.host.sessionId || scope) &&
      info.finish &&
      this.pendingText.has(info.id)
    )
      this.flushText(info.id, this.phaseOf(info.finish));
  }
  private onTextDelta(sessionID: string, partID: string, delta: string): void {
    const scope = this.scopeOf(sessionID);
    if (sessionID !== this.host.sessionId && !scope) return;
    if (this.parts.get(partID) === "reasoning")
      this.host.emit({
        type: "reasoning_delta",
        id: partID,
        summaryIndex: 0,
        text: delta,
        ...scope,
      });
    else this.host.emit({ type: "delta", id: partID, text: delta, ...scope });
  }
  private onSessionUpdated(info: Session): void {
    this.openChild(info);
    if (info.id !== this.host.sessionId) return;
    const token = info.metadata?.cf_sync;
    if (typeof token === "string") this.host.echoed(token);
  }
  /** One event of the feed. */
  accept(event: Event): void {
    if (process.env.CF_OPENCODE_TRACE) this.host.diagnostics(`opencode-event ${trace(event)}`);
    switch (event.type) {
      case "session.created":
        this.openChild(event.properties.info);
        return;
      case "session.updated":
        this.onSessionUpdated(event.properties.info);
        return;
      case "message.updated":
        if (event.properties.info.role === "assistant")
          this.onAssistantMessage(event.properties.info);
        return;
      case "message.part.updated":
        this.collectPart(event.properties.part);
        return;
      case "message.part.delta":
        if (event.properties.field === "text")
          this.onTextDelta(
            event.properties.sessionID,
            event.properties.partID,
            event.properties.delta,
          );
        return;
      case "session.status": {
        if (event.properties.status.type !== "retry") return;
        const { attempt, message, next } = event.properties.status;
        this.host.diagnostics(
          `opencode retry session=${event.properties.sessionID} attempt=${attempt} next_in_ms=${Math.max(0, next - Date.now())}: ${message}`,
        );
        return;
      }
      case "session.idle": {
        const child = this.host.children.get(event.properties.sessionID);
        if (child) this.closeChild(child, "completed");
        if (event.properties.sessionID === this.host.sessionId) this.host.idle();
        return;
      }
      case "session.error": {
        const child = this.host.children.get(event.properties.sessionID ?? "");
        if (child) this.closeChild(child, "failed");
        if (event.properties.error)
          this.host.diagnostics(
            `opencode session.error session=${event.properties.sessionID ?? "none"}: ${event.properties.error.name}`,
          );
        return;
      }
      default:
        return;
    }
  }
}

function trace(event: Event): string {
  const properties = (event as { properties?: Record<string, unknown> }).properties ?? {};
  const summary: Record<string, unknown> = { type: event.type };
  if ("sessionID" in properties) summary.sessionID = properties.sessionID;
  if ("part" in properties) {
    const part = properties.part as Part;
    summary.part = {
      type: part.type,
      id: part.id,
      messageID: part.messageID,
      ...(part.type === "tool"
        ? {
            tool: part.tool,
            callID: part.callID,
            status: part.state.status,
            ...(part.state.status === "error" ? { error: part.state.error.slice(0, 300) } : {}),
          }
        : {}),
      ...(part.type === "step-finish" ? { reason: part.reason } : {}),
      ...(part.type === "text" ? { end: !!part.time?.end } : {}),
    };
  }
  if ("info" in properties) {
    const info = properties.info as Record<string, unknown>;
    summary.info = {
      id: info.id,
      role: info.role,
      finish: info.finish,
      parentID: info.parentID,
      error: (info.error as { name?: string } | undefined)?.name,
      structured: info.structured !== undefined,
    };
  }
  if ("status" in properties) summary.status = properties.status;
  return JSON.stringify(summary);
}
