import { DurableObject } from "cloudflare:workers";

import type {
  AgentConfig,
  AgentSession,
  AgentSessionEvent,
  AgentSessionItem,
  InputEvent,
  InputMessage,
  PageQuery,
  Turn,
} from "./protocol.js";
import { ApiError, canonicalJSON, identifier, type RpcResult, rpcFailure } from "./protocol.js";
import type { Checkpoint, Execution, RuntimeCommand, RuntimeDriver } from "./runtime.js";
import { acceptRuntimeEvent, recordToolResult } from "./session-events.js";
import { SqlStore } from "./storage.js";

export interface SessionRecord {
  tenant: string;
  session: AgentSession;
  agent: AgentConfig;
  driver: string;
  revision: string;
  model: string;
  generation: number;
  checkpoint: Checkpoint | null;
  execution: Execution | null;
  cursor: number;
  phase: "idle" | "starting" | "running" | "checkpointing" | "failed";
  deleted: boolean;
}
interface Command {
  id: string;
  turnId: string;
  command: RuntimeCommand;
}
export interface SessionDependencies {
  drivers: Record<string, RuntimeDriver>;
  maxTurnMs: number;
  pollIntervalMs: number;
}

export class SessionObject<Env = unknown> extends DurableObject<Env> {
  readonly db: SqlStore;
  private busy = false;
  private readonly listeners = new Map<ReadableStreamDefaultController<Uint8Array>, number>();
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = new SqlStore(ctx.storage);
  }
  protected dependencies(): SessionDependencies {
    throw new Error("SessionObject must be configured through createAgentService");
  }
  initialize(record: SessionRecord): AgentSession {
    const existing = this.db.get<SessionRecord>("state", "session");
    if (existing) return existing.session;
    this.db.transaction(() => {
      this.save(record);
      this.emit({
        event_id: identifier("evt"),
        type: "agent.session.created",
        session: record.session,
      });
    });
    return record.session;
  }
  private record(): SessionRecord {
    const record = this.db.require<SessionRecord>("state", "session");
    if (record.deleted) throw new ApiError(404, "not_found", "Session not found");
    return record;
  }
  private save(record: SessionRecord): void {
    this.db.put("state", "session", record);
  }
  private emit(event: AgentSessionEvent): void {
    this.db.append(event);
  }
  retrieve(): AgentSession {
    return this.record().session;
  }
  update(metadata: Record<string, string>): AgentSession {
    const record = this.record();
    record.session.metadata = metadata;
    this.save(record);
    return record.session;
  }
  items(query: PageQuery) {
    this.record();
    return this.db.list<AgentSessionItem>("item", query);
  }
  turns(query: PageQuery) {
    this.record();
    return this.db.list<Turn>("turn", query);
  }
  turn(id: string): Turn {
    this.record();
    return this.db.require<Turn>("turn", id);
  }
  replay(after: number) {
    this.record();
    return this.db.events<AgentSessionEvent>(after);
  }

  async submit(events: InputEvent[], key: string): Promise<RpcResult<null>> {
    try {
      // Arm before committing inputs. A crash in between produces a harmless empty alarm.
      await this.ctx.storage.setAlarm(Date.now() + 1);
      this.db.transaction(() => {
        const record = this.record();
        const fingerprint = canonicalJSON(events);
        const previous = this.db.get<string>("idempotency", key);
        if (previous) {
          if (previous !== fingerprint)
            throw new ApiError(409, "idempotency_conflict", "Key was used with different input");
          return;
        }
        if (record.phase === "failed")
          throw new ApiError(
            409,
            "session_failed",
            "Fork or create a new session after an indeterminate execution",
          );
        if (record.phase === "checkpointing")
          throw new ApiError(409, "turn_checkpointing", "Wait for the current turn to become idle");
        const driver = this.driver(record);
        for (const event of events) {
          if (event.type === "agent.session.input.message") {
            if (record.execution) {
              if (!driver.capabilities.steer)
                throw new ApiError(
                  409,
                  "active_turn_not_steerable",
                  "This harness cannot steer an active turn",
                );
              this.enqueue(record, { type: "steer", input: event.input });
            } else this.begin(record, event.input);
            this.addInput(record, event.input);
          } else if (event.type === "agent.session.input.cancel") {
            if (record.execution) this.enqueue(record, { type: "cancel" });
          } else {
            const action = record.session.required_actions.find(
              (action) =>
                action.type === "function_call" &&
                action.call_id === event.call_id &&
                action.turn_id === event.turn_id,
            );
            if (!action)
              throw new ApiError(409, "invalid_tool_result", "No matching required action");
            recordToolResult(this.db, record, event);
            this.enqueue(record, {
              type: "tool_result",
              callId: event.call_id,
              success: event.success,
              output: event.success ? (event.output ?? "") : (event.error ?? "Tool failed"),
            });
            record.session.required_actions = record.session.required_actions.filter(
              (value) => value !== action,
            );
            if (record.session.required_actions.length === 0) {
              record.session.status = "in_progress";
              const turn = this.turn(event.turn_id);
              turn.status = "in_progress";
              this.db.put("turn", turn.id, turn);
              this.emit({
                type: "agent.session.in_progress",
                event_id: identifier("evt"),
                session: record.session,
              });
            }
          }
        }
        this.db.put("idempotency", key, fingerprint);
        this.save(record);
      });
      this.flush();
      return { ok: true, value: null };
    } catch (error) {
      return rpcFailure(error);
    }
  }
  private driver(record: SessionRecord): RuntimeDriver {
    const driver = this.dependencies().drivers[record.driver];
    if (!driver || driver.revision !== record.revision)
      throw new ApiError(
        503,
        "executor_version_incompatible",
        "Session requires its original harness revision",
      );
    return driver;
  }
  private begin(record: SessionRecord, input: InputMessage[]): void {
    const now = Math.floor(Date.now() / 1_000);
    const id = identifier("turn");
    record.generation++;
    record.execution = {
      sessionId: record.session.id,
      turnId: id,
      generation: record.generation,
      agent: record.agent,
      harness: record.driver,
      model: record.model,
      input,
      checkpoint: record.checkpoint,
      deadline: Date.now() + this.dependencies().maxTurnMs,
      sandbox: record.session.environment.type !== "none",
    };
    record.cursor = 0;
    record.phase = "starting";
    record.session.status = "in_progress";
    record.session.last_active_at = now;
    const turn: Turn = {
      id,
      object: "agent.session.turn",
      agent_id: record.session.agent.id,
      session_id: record.session.id,
      status: "queued",
      created_at: now,
      started_at: null,
      completed_at: null,
      error: null,
      subagent_id: null,
      usage: null,
    };
    this.db.put("turn", id, turn);
    this.emit({
      event_id: identifier("evt"),
      type: "agent.session.turn.created",
      session_id: record.session.id,
      turn_id: id,
      turn,
    });
    this.emit({
      event_id: identifier("evt"),
      type: "agent.session.in_progress",
      session: record.session,
    });
  }
  private addInput(record: SessionRecord, input: InputMessage[]): void {
    for (const message of input) {
      const item = {
        ...message,
        id: identifier("msg"),
        type: "message" as const,
        turn_id: record.execution?.turnId ?? "",
        phase: null,
        status: "completed" as const,
      };
      this.db.put("item", item.id, item);
    }
  }
  private enqueue(record: SessionRecord, command: RuntimeCommand): void {
    const id = identifier("op");
    if (!record.execution) throw new Error("A command requires an active turn");
    this.db.put("command", id, { id, turnId: record.execution.turnId, command } satisfies Command);
  }
  override async alarm(): Promise<void> {
    if (this.busy) {
      await this.ctx.storage.setAlarm(Date.now() + this.dependencies().pollIntervalMs);
      return;
    }
    this.busy = true;
    try {
      await this.advance();
    } finally {
      this.busy = false;
      this.flush();
      if (this.db.get<SessionRecord>("state", "session")?.execution) {
        await this.ctx.storage.setAlarm(Date.now() + this.dependencies().pollIntervalMs);
      }
    }
  }
  private async advance(): Promise<void> {
    const initial = this.db.get<SessionRecord>("state", "session");
    if (!initial?.execution || initial.deleted) return;
    const execution = initial.execution;
    // An alarm is a durable reconciliation loop, including while network I/O is pending.
    await this.ctx.storage.setAlarm(Date.now() + this.dependencies().pollIntervalMs);
    let driver: RuntimeDriver;
    try {
      driver = this.driver(initial);
    } catch {
      // A new implementation may still contain the previous runtime by ID.
      const replacement = this.dependencies().drivers[initial.driver];
      if (replacement) await replacement.stop(execution);
      else return; // Keep reconciling: never declare an uncontained executor stopped.
      this.finish("failed", "executor_version_incompatible");
      return;
    }
    try {
      if (Date.now() >= execution.deadline) {
        await driver.stop(execution);
        this.finish("failed", "request_timeout");
        return;
      }
      if (initial.phase === "starting") {
        await driver.start(execution, `${execution.turnId}:start`);
        this.db.transaction(() => {
          const record = this.record();
          if (record.execution?.generation !== execution.generation) return;
          record.phase = "running";
          this.save(record);
          const turn = this.turn(execution.turnId);
          turn.status = "in_progress";
          turn.started_at = Math.floor(Date.now() / 1_000);
          this.db.put("turn", turn.id, turn);
          this.emit({
            type: "agent.session.turn.in_progress",
            event_id: identifier("evt"),
            session_id: execution.sessionId,
            turn_id: turn.id,
            turn,
          });
        });
      }
      for (const operation of this.db.list<Command>("command", { order: "asc", limit: 100 }).data) {
        if (operation.turnId !== execution.turnId) {
          this.db.remove("command", operation.id);
          continue;
        }
        await driver.control(execution, operation.id, operation.command);
        this.db.remove("command", operation.id);
      }
      const batch = await driver.poll(execution, this.record().cursor);
      this.db.transaction(() => {
        const record = this.record();
        if (record.execution?.generation !== execution.generation) return;
        for (const entry of batch.events) {
          if (entry.seq <= record.cursor) continue;
          acceptRuntimeEvent(this.db, record, entry.event);
          record.cursor = entry.seq;
        }
        if (batch.status === "completed") record.phase = "checkpointing";
        this.save(record);
      });
      if (batch.status === "completed") {
        const checkpoint = await driver.checkpoint(execution);
        this.db.transaction(() => {
          const record = this.record();
          if (record.execution?.generation !== execution.generation) return;
          if (checkpoint.driver !== record.driver || checkpoint.revision !== record.revision)
            throw new ApiError(
              409,
              "invalid_checkpoint",
              "Checkpoint has an incompatible harness revision",
            );
          record.checkpoint = checkpoint;
          this.save(record);
          this.finish("completed");
        });
      } else if (batch.status === "failed" || batch.status === "missing") {
        await driver.stop(execution);
        this.finish(
          "failed",
          batch.status === "missing" ? "outcome_unknown" : (batch.error ?? "executor_failed"),
        );
      } else if (batch.status === "cancelled") {
        await driver.stop(execution);
        this.finish("cancelled");
      }
    } catch (error) {
      // Network failures are retried with the same operation IDs until the deadline.
      // Driver implementations distinguish a vanished execution from a transient error.
      console.error("Session reconciliation failed", {
        sessionId: execution.sessionId,
        turnId: execution.turnId,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }
  private finish(status: "completed" | "cancelled" | "failed", error?: string): void {
    this.db.transaction(() => {
      const record = this.record();
      if (!record.execution) return;
      const turn = this.turn(record.execution.turnId);
      turn.status = status;
      turn.completed_at = Math.floor(Date.now() / 1_000);
      turn.error = error ? { code: "internal_error", message: error } : null;
      this.db.put("turn", turn.id, turn);
      this.db.clear("command");
      record.execution = null;
      record.phase = status === "failed" ? "failed" : "idle";
      record.session.status = status === "failed" ? "failed" : "idle";
      record.session.error = error ?? null;
      record.session.required_actions = [];
      this.save(record);
      this.emit({
        type: `agent.session.turn.${status}`,
        event_id: identifier("evt"),
        session_id: record.session.id,
        turn_id: turn.id,
        turn,
        usage: null,
      });
      this.emit({
        type: status === "failed" ? "agent.session.failed" : "agent.session.idle",
        event_id: identifier("evt"),
        session: record.session,
      });
    });
  }
  async delete(): Promise<{ id: string; object: "agent.session.deleted"; deleted: true }> {
    const record = this.record();
    if (record.execution)
      throw new ApiError(409, "active_turn", "Cancel the active turn before deleting the session");
    record.deleted = true;
    this.save(record);
    for (const listener of this.listeners.keys()) listener.close();
    this.listeners.clear();
    return { id: record.session.id, object: "agent.session.deleted", deleted: true };
  }
  stream(after?: number): Response {
    this.record();
    if (this.listeners.size >= 64)
      throw new ApiError(429, "stream_limit", "Too many live streams for this session");
    const cursor = after ?? this.db.lastEvent();
    let controller: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>(
      {
        start: (value) => {
          controller = value;
          this.listeners.set(value, cursor);
          this.flush();
        },
        pull: () => this.flush(),
        cancel: () => {
          this.listeners.delete(controller);
        },
      },
      { highWaterMark: 64 * 1024, size: (chunk) => chunk.byteLength },
    );
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        "x-accel-buffering": "no",
      },
    });
  }
  private flush(): void {
    for (const [listener, cursor] of this.listeners) {
      if ((listener.desiredSize ?? 0) <= 0) continue;
      const entries = this.db.events<AgentSessionEvent>(cursor, 64);
      for (const { seq, event } of entries) {
        if ((listener.desiredSize ?? 0) <= 0) break;
        listener.enqueue(
          new TextEncoder().encode(
            `id: ${seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
          ),
        );
        this.listeners.set(listener, seq);
      }
    }
  }
}
