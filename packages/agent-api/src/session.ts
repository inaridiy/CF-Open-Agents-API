import { DurableObject } from "cloudflare:workers";
import { Context, Effect, Layer, Schema } from "effect";
import { attempt, io, runPromise } from "./effect.js";

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
import {
  type Checkpoint,
  type Execution,
  executionSchema,
  type RuntimeCommand,
  type RuntimeDriver,
} from "./runtime.js";
import { acceptRuntimeEvent, recordToolResult } from "./session-events.js";
import { SqlStore } from "./storage.js";

interface SessionBase {
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

class Reconciliation extends Context.Tag("agent-api/Reconciliation")<
  Reconciliation,
  SessionDependencies
>() {}

export class SessionObject<Env = unknown> extends DurableObject<Env> {
  readonly db: SqlStore;
  private readonly reconciliation = Effect.unsafeMakeSemaphore(1);
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
    this.validate(record);
    if (record.deleted) throw new ApiError(404, "not_found", "Session not found");
    return record;
  }
  private validate(record: SessionRecord): void {
    if (
      !Schema.is(executionState)(record) ||
      (record.execution &&
        (record.execution.generation !== record.generation ||
          record.execution.sessionId !== record.session.id))
    )
      throw new ApiError(409, "invalid_session_state", "Persisted execution state is inconsistent");
  }
  private save(record: SessionRecord): void {
    this.validate(record);
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
    const next = { ...record, session: { ...record.session, metadata } };
    this.save(next);
    return next.session;
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

  submit(events: InputEvent[], key: string): Promise<RpcResult<null>> {
    return runPromise(
      Effect.gen(this, function* () {
        // Persist the wakeup first; the synchronous input transaction then cannot be orphaned.
        yield* io("session.arm", () => this.ctx.storage.setAlarm(Date.now() + 1));
        yield* attempt("session.submit", () =>
          this.db.transaction(() => {
            let record = this.record();
            const fingerprint = canonicalJSON(events);
            const previous = this.db.get<string>("idempotency", key);
            if (previous) {
              if (previous !== fingerprint)
                throw new ApiError(
                  409,
                  "idempotency_conflict",
                  "Key was used with different input",
                );
              return;
            }
            if (record.phase === "failed")
              throw new ApiError(
                409,
                "session_failed",
                "Fork or create a new session after an indeterminate execution",
              );
            if (record.phase === "checkpointing")
              throw new ApiError(
                409,
                "turn_checkpointing",
                "Wait for the current turn to become idle",
              );
            const driver = this.driver(record);
            for (const event of events) {
              switch (event.type) {
                case "agent.session.input.message": {
                  if (record.execution) {
                    if (!driver.capabilities.steer)
                      throw new ApiError(
                        409,
                        "active_turn_not_steerable",
                        "This harness cannot steer an active turn",
                      );
                    this.enqueue(record, { type: "steer", input: event.input });
                  } else record = this.begin(record, event.input);
                  this.addInput(record, event.input);
                  break;
                }
                case "agent.session.input.cancel":
                  if (record.execution) this.enqueue(record, { type: "cancel" });
                  break;
                case "agent.session.input.tool_result": {
                  const action = record.session.required_actions.find(
                    (action) =>
                      action.type === "function_call" &&
                      action.call_id === event.call_id &&
                      action.turn_id === event.turn_id,
                  );
                  if (!action || !record.execution)
                    throw new ApiError(409, "invalid_tool_result", "No matching required action");
                  recordToolResult(this.db, record, event);
                  this.enqueue(record, {
                    type: "tool_result",
                    callId: event.call_id,
                    success: event.success,
                    output: event.success ? (event.output ?? "") : (event.error ?? "Tool failed"),
                  });
                  const required_actions = record.session.required_actions.filter(
                    (value) => value !== action,
                  );
                  record = {
                    ...record,
                    session: {
                      ...record.session,
                      required_actions,
                      status: required_actions.length ? "requires_action" : "in_progress",
                    },
                  };
                  if (!required_actions.length) {
                    const turn = this.turn(event.turn_id);
                    this.db.put("turn", turn.id, { ...turn, status: "in_progress" });
                    this.emit({
                      type: "agent.session.in_progress",
                      event_id: identifier("evt"),
                      session: record.session,
                    });
                  }
                  break;
                }
              }
            }
            this.db.put("idempotency", key, fingerprint);
            this.save(record);
          }),
        );
        this.flush();
        return { ok: true, value: null } as const;
      }).pipe(Effect.catchTag("ApiError", (error) => Effect.succeed(rpcFailure(error)))),
    );
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
  private begin(record: SessionRecord, input: InputMessage[]): ActiveSession {
    const now = Math.floor(Date.now() / 1_000);
    const id = identifier("turn");
    const next: ActiveSession = {
      ...record,
      generation: record.generation + 1,
      execution: {
        sessionId: record.session.id,
        turnId: id,
        generation: record.generation + 1,
        agent: record.agent,
        harness: record.driver,
        model: record.model,
        input,
        checkpoint: record.checkpoint,
        deadline: Date.now() + this.dependencies().maxTurnMs,
        sandbox: record.session.environment.type !== "none",
      },
      cursor: 0,
      phase: "starting",
      session: { ...record.session, status: "in_progress", last_active_at: now },
    };
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
      session: next.session,
    });
    return next;
  }
  private addInput(record: ActiveSession, input: InputMessage[]): void {
    for (const message of input) {
      const item = {
        ...message,
        id: identifier("msg"),
        type: "message" as const,
        turn_id: record.execution.turnId,
        phase: null,
        status: "completed" as const,
      };
      this.db.put("item", item.id, item);
    }
  }
  private enqueue(record: ActiveSession, command: RuntimeCommand): void {
    if (command.type === "cancel") {
      if (!this.db.get("cancellation", record.execution.turnId))
        this.db.put("cancellation", record.execution.turnId, {
          id: identifier("op"),
          turnId: record.execution.turnId,
          command,
        } satisfies Command);
      return;
    }
    const id = identifier("op");
    this.db.put("command", id, { id, turnId: record.execution.turnId, command } satisfies Command);
  }
  override alarm(): Promise<void> {
    const arm = io("session.arm", () =>
      this.ctx.storage.setAlarm(Date.now() + this.dependencies().pollIntervalMs),
    );
    const reconcile = this.advance().pipe(
      Effect.catchAllCause((cause) => Effect.logError("Session reconciliation failed", cause)),
      Effect.ensuring(
        Effect.gen(this, function* () {
          this.flush();
          if (this.db.get<SessionRecord>("state", "session")?.execution)
            yield* arm.pipe(Effect.orDie);
        }),
      ),
    );
    return runPromise(
      this.reconciliation
        .withPermitsIfAvailable(1)(reconcile)
        .pipe(Effect.asVoid, Effect.provide(Layer.succeed(Reconciliation, this.dependencies()))),
    );
  }
  /** Every post-I/O transition compares the full durable execution identity. */
  private current(execution: Execution): ActiveSession | undefined {
    const record = this.db.get<SessionRecord>("state", "session");
    return record &&
      !record.deleted &&
      record.execution?.generation === execution.generation &&
      record.execution.turnId === execution.turnId
      ? (record as ActiveSession)
      : undefined;
  }
  private transition<A>(execution: Execution, f: (record: ActiveSession) => A) {
    return attempt("session.transition", () =>
      this.db.transaction(() => {
        const record = this.current(execution);
        return record ? f(record) : undefined;
      }),
    );
  }
  private advance() {
    return Effect.gen(this, function* () {
      const dependencies = yield* Reconciliation;
      const initial = this.db.get<SessionRecord>("state", "session");
      if (!initial?.execution || initial.deleted) return;
      yield* attempt("session.validate", () => this.validate(initial));
      const execution = initial.execution;
      yield* io("session.arm", () =>
        this.ctx.storage.setAlarm(Date.now() + dependencies.pollIntervalMs),
      );
      const driver = dependencies.drivers[initial.driver];
      if (!driver) return; // Cannot claim containment when its original executor is unavailable.
      if (driver.revision !== initial.revision) {
        yield* driver.stop(execution);
        yield* this.finish(execution, "failed", "executor_version_incompatible");
        return;
      }
      // Once completion is durable, recover the checkpoint directly, even if compute vanished.
      if (initial.phase === "checkpointing") {
        yield* this.checkpoint(driver, execution);
        return;
      }
      if (Date.now() >= execution.deadline) {
        yield* driver.stop(execution);
        yield* this.finish(execution, "failed", "request_timeout");
        return;
      }
      if (initial.phase === "starting") {
        yield* driver.start(execution, `${execution.turnId}:start`);
        yield* this.transition(execution, (record) => {
          this.save({ ...record, phase: "running" });
          const turn = {
            ...this.turn(execution.turnId),
            status: "in_progress" as const,
            started_at: Math.floor(Date.now() / 1000),
          };
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
      while (this.current(execution)) {
        if (Date.now() >= execution.deadline) {
          yield* driver.stop(execution);
          yield* this.finish(execution, "failed", "request_timeout");
          return;
        }
        // Cancellation supersedes queued input. Keep its operation ID until the
        // native terminal outcome is durable, including across lost responses.
        const cancellation = this.db.get<Command>("cancellation", execution.turnId);
        // Also accept cancellation records written by the previous implementation.
        const queued = this.db.list<Command>("command", { order: "asc", limit: 100 }).data;
        const legacyCancellation = queued.find((operation) => operation.command.type === "cancel");
        const cancel = cancellation ?? legacyCancellation;
        if (cancel && !cancellation)
          yield* this.transition(execution, () =>
            this.db.put("cancellation", execution.turnId, cancel),
          );
        const commands = cancel ? [cancel] : queued;
        for (const operation of commands) {
          if (!this.current(execution)) return;
          if (operation.turnId === execution.turnId)
            yield* driver
              .control(execution, operation.id, operation.command)
              .pipe(
                Effect.catchAll((error) =>
                  cancel
                    ? Effect.logWarning(
                        "Cancellation delivery failed; reconciling native outcome",
                        error,
                      )
                    : Effect.fail(error),
                ),
              );
          if (!cancel)
            yield* this.transition(execution, () => this.db.remove("command", operation.id));
        }
        const current = this.current(execution);
        if (!current) return;
        const batch = yield* driver.poll(execution, current.cursor);
        const phase = yield* this.transition(execution, (record) => {
          let next = record;
          for (const entry of batch.events) {
            if (entry.seq <= next.cursor) continue;
            if (entry.seq !== next.cursor + 1)
              throw new ApiError(
                409,
                "invalid_runtime_cursor",
                "Runtime events must be contiguous",
              );
            next = { ...acceptRuntimeEvent(this.db, next, entry.event), cursor: entry.seq };
          }
          // A command accepted during poll must be delivered before sealing completion.
          const pending =
            !cancel && this.db.list<Command>("command", { order: "asc", limit: 1 }).data.length > 0;
          if (batch.status === "completed" && !pending) next = { ...next, phase: "checkpointing" };
          this.save(next);
          return pending ? "commands" : next.phase;
        });
        if (!phase) return;
        if (phase === "checkpointing") {
          yield* this.checkpoint(driver, execution);
          return;
        }
        if (batch.status === "failed" || batch.status === "missing") {
          yield* driver.stop(execution);
          yield* this.finish(
            execution,
            "failed",
            batch.status === "missing" ? "outcome_unknown" : (batch.error ?? "executor_failed"),
          );
          return;
        }
        if (batch.status === "cancelled") {
          yield* driver.stop(execution);
          yield* this.finish(execution, "cancelled");
          return;
        }
        if (phase !== "commands") return;
      }
    });
  }
  private checkpoint(driver: RuntimeDriver, execution: Execution) {
    return Effect.gen(this, function* () {
      const checkpoint = yield* driver.checkpoint(execution);
      yield* this.transition(execution, (record) => {
        if (checkpoint.driver !== record.driver || checkpoint.revision !== record.revision)
          throw new ApiError(
            409,
            "invalid_checkpoint",
            "Checkpoint has an incompatible harness revision",
          );
        this.complete({ ...record, checkpoint }, "completed");
      });
    }).pipe(
      Effect.catchAll((error) => {
        if (error._tag === "ApiError" || Date.now() >= execution.deadline) {
          return driver
            .stop(execution)
            .pipe(
              Effect.zipRight(
                this.finish(
                  execution,
                  "failed",
                  error._tag === "ApiError" ? error.code : "checkpoint_unavailable",
                ),
              ),
              Effect.asVoid,
            );
        }
        return Effect.fail(error);
      }),
    );
  }
  private finish(execution: Execution, status: "cancelled" | "failed", error?: string) {
    return this.transition(execution, (record) => this.complete(record, status, error));
  }
  /** Must run in the transition transaction, together with the checkpoint and event log. */
  private complete(
    record: ActiveSession,
    status: "completed" | "cancelled" | "failed",
    error?: string,
  ): void {
    const turn: Turn = {
      ...this.turn(record.execution.turnId),
      status,
      completed_at: Math.floor(Date.now() / 1000),
      error: error ? { code: "internal_error", message: error } : null,
    };
    this.db.put("turn", turn.id, turn);
    this.db.clear("command");
    this.db.clear("cancellation");
    const next: SessionRecord = {
      ...record,
      execution: null,
      phase: status === "failed" ? "failed" : "idle",
      session: {
        ...record.session,
        status: status === "failed" ? "failed" : "idle",
        error: error ?? null,
        required_actions: [],
      },
    };
    this.save(next);
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
      session: next.session,
    });
  }
  async delete(): Promise<{ id: string; object: "agent.session.deleted"; deleted: true }> {
    const record = this.db.require<SessionRecord>("state", "session");
    if (record.execution)
      throw new ApiError(409, "active_turn", "Cancel the active turn before deleting the session");
    this.save({ ...record, deleted: true });
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
