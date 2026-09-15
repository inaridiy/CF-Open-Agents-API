import { DurableObject } from "cloudflare:workers";
import { type Context, Effect, Option, Schema } from "effect";
import type { AgentSessionEnvironmentState, Subagent } from "openai/resources/beta/agents/agents";

import { attempt, runSync, settle } from "./effect.js";
import type { EnvironmentSpec } from "./environments.js";
import { encodeRpc, rpcEnvelope } from "./errors.js";
import { SessionKinds } from "./persistence/session-kinds.js";
import { type ArtifactRecord, migrate, type SessionRecord } from "./persistence/session-record.js";
import { makeSessionRepo, type SessionRepo } from "./persistence/session-repo.js";
import { makeSessionTx, type SessionTx } from "./persistence/session-tx.js";
import type {
  AgentConfig,
  AgentSession,
  AgentSessionEvent,
  AgentSessionItem,
  InputEvent,
  PageQuery,
  Turn,
} from "./protocol.js";
import { ApiError, identifier } from "./protocol.js";
import type { Checkpoint, RuntimeDriver } from "./runtime.js";
import { reconcileTick } from "./session-reconcile.js";
import {
  Alarm,
  alarmFromStorage,
  Drivers,
  driversFrom,
  makeSessionRuntime,
  Repo,
  type SessionDependencies,
  type SessionServices,
} from "./session-services.js";
import {
  acceptInput,
  applyEnvironmentStatus,
  type Deleted,
  markDeleted,
  purgeRecords,
  type TurnConfig,
} from "./session-state.js";
import { SqlStore } from "./storage.js";

export type { ActiveSession, ArtifactRecord, SessionRecord } from "./persistence/session-record.js";
export type { SessionDependencies } from "./session-services.js";
export { isIndeterminate, transcriptMessage } from "./session-state.js";

/** Committed state another session can continue from. */
export interface ForkSource {
  session: AgentSession;
  agent: AgentConfig;
  driver: string;
  revision: string;
  model: string;
  checkpoint: Checkpoint | null;
  environmentSpec?: EnvironmentSpec;
  lastTurnId: string | null;
  transcript: string;
}
const forkSourceSchema = Schema.declare<ForkSource>(
  (input): input is ForkSource =>
    typeof input === "object" && input !== null && "session" in input && "transcript" in input,
);
/** String carrier: the RPC type of the public session shape is too deep for the stub. */
export const ForkSourceResult = Schema.parseJson(rpcEnvelope(forkSourceSchema));
export const SubmitResult = rpcEnvelope(Schema.Null);
/** Leading input of a fork's first turn; the harness reads it as ordinary context. */
export const TRANSCRIPT_LIMIT = 96_000;
const TRANSCRIPT_ENTRY_LIMIT = 4_000;
const clip = (text: string) =>
  text.length > TRANSCRIPT_ENTRY_LIMIT
    ? `${text.slice(0, TRANSCRIPT_ENTRY_LIMIT)}… [truncated]`
    : text;
const json = (value: unknown) => clip(typeof value === "string" ? value : JSON.stringify(value));
function transcriptEntry(item: AgentSessionItem): string | undefined {
  switch (item.type) {
    case "message": {
      const text = item.content
        .map((part) =>
          part.type === "input_text" || part.type === "output_text"
            ? part.text
            : part.type === "input_image"
              ? "[image]"
              : "",
        )
        .join("\n");
      return `${item.role === "user" ? "User" : "Assistant"}: ${clip(text)}`;
    }
    case "function_call":
      return `Assistant called ${item.name}(${json(item.arguments)})`;
    case "function_call_output":
      return `Function result (${item.status}): ${json(item.output ?? item.error ?? null)}`;
    case "command_execution":
      return `Command${item.cwd ? ` in ${item.cwd}` : ""}: ${clip(item.command)}\nExit code: ${item.exit_code ?? "none"}\n${clip(item.output ?? "")}`;
    case "mcp_call":
      return `MCP ${item.server_label}/${item.name}(${json(item.arguments)}) → ${json(item.output ?? item.error ?? null)}`;
    case "web_search_call":
      return `Web search: ${json(item.action)}`;
    default:
      // Reasoning and collaboration items are private to the original runtime.
      return undefined;
  }
}
/** Accumulates items page by page and only ever retains the bounded tail. */
export class TranscriptBuilder {
  private readonly entries: string[] = [];
  private total = 0;
  private omitted = 0;
  private get joined(): number {
    return this.total + 2 * Math.max(0, this.entries.length - 1);
  }
  add(items: readonly AgentSessionItem[]): void {
    for (const item of items) {
      const entry = transcriptEntry(item);
      if (entry === undefined) continue;
      this.entries.push(entry);
      this.total += entry.length;
      while (this.joined > TRANSCRIPT_LIMIT && this.entries.length > 1) {
        this.total -= this.entries.shift()?.length ?? 0;
        this.omitted++;
      }
    }
  }
  render(): string {
    let rendered = this.entries.join("\n\n");
    if (rendered.length > TRANSCRIPT_LIMIT) rendered = rendered.slice(-TRANSCRIPT_LIMIT);
    return this.omitted ? `[${this.omitted} earlier entries omitted]\n\n${rendered}` : rendered;
  }
}
export function renderTranscript(items: readonly AgentSessionItem[]): string {
  const builder = new TranscriptBuilder();
  builder.add(items);
  return builder.render();
}
/** The deployment must still register the session's harness at its original revision. */
function requireDriver(
  drivers: Context.Tag.Service<Drivers>,
  record: SessionRecord,
): RuntimeDriver {
  const driver = Option.getOrUndefined(drivers.get(record.driver));
  if (!driver || driver.revision !== record.revision)
    throw new ApiError(
      503,
      "executor_version_incompatible",
      "Session requires its original harness revision",
    );
  return driver;
}
/** Persist the wakeup first; the synchronous input transaction then cannot be orphaned. */
const submitProgram = (events: InputEvent[], key: string) =>
  Effect.gen(function* () {
    const alarm = yield* Alarm;
    const drivers = yield* Drivers;
    const repo = yield* Repo;
    yield* alarm.arm(1);
    const config: TurnConfig = { maxTurnMs: drivers.maxTurnMs, agents: drivers.agents };
    yield* repo.transaction((tx) =>
      acceptInput(tx, config, (record) => requireDriver(drivers, record), events, key),
    );
    return null;
  });
interface Listener {
  cursor: number;
  /** A creation stream ends once the initial turn settles or when there is no input. */
  initial: boolean;
}
export class SessionObject<Env = unknown> extends DurableObject<Env> {
  /** The durable store; tests read it through `SessionKinds`. */
  readonly db = new SqlStore(this.ctx.storage);
  /** Synchronous typed view for the plain RPC reads. */
  private readonly tx: SessionTx = makeSessionTx(this.db);
  /** Effect edge of the seam: one `transactionSync` per `transaction`. */
  private readonly repo: SessionRepo = makeSessionRepo(this.db, this.ctx.storage);
  /**
   * One runtime per object with exactly three services; every asynchronous entrypoint
   * runs its program here and nothing below an entrypoint calls `Effect.run*`.
   */
  private readonly runtime = makeSessionRuntime({
    repo: this.repo,
    alarm: alarmFromStorage(this.ctx.storage),
    drivers: driversFrom(() => this.dependencies()),
  });
  private readonly reconciliation = Effect.unsafeMakeSemaphore(1);
  private readonly listeners = new Map<ReadableStreamDefaultController<Uint8Array>, Listener>();
  private keepalive: ReturnType<typeof setInterval> | undefined;
  private flushing = false;
  protected dependencies(): SessionDependencies {
    throw new Error("SessionObject must be configured through createAgentService");
  }
  /** Boundary runner: a failure is thrown as itself so its RPC wire name survives. */
  private run<A, E>(program: Effect.Effect<A, E, SessionServices>): Promise<A> {
    return this.runtime.runPromiseExit(program).then(settle);
  }
  /** Push newly durable events to live streams; runs once an entrypoint's writes commit. */
  private readonly wake = Effect.sync(() => this.flush());
  private readonly close = Effect.sync(() => this.closeListeners());
  initialize(record: SessionRecord): AgentSession {
    const existing = this.db.get(SessionKinds.state, "session");
    if (existing) return existing.session;
    let migrated = record;
    this.db.transaction(() => {
      migrated = migrate(record);
      this.save(migrated);
      this.emit({
        event_id: identifier("evt"),
        type: "agent.session.created",
        session: migrated.session,
      });
    });
    return migrated.session;
  }
  private record(): SessionRecord {
    return this.tx.requireSession();
  }
  private save(record: SessionRecord): void {
    this.tx.save(record);
  }
  private emit(event: AgentSessionEvent): void {
    this.tx.emit(event);
  }
  retrieve(): AgentSession {
    return this.record().session;
  }
  environmentStatus(status: AgentSessionEnvironmentState["status"]): Promise<void> {
    return this.run(
      Effect.flatMap(Repo, (repo) =>
        repo.transaction((tx) => applyEnvironmentStatus(tx, status)),
      ).pipe(Effect.zipRight(this.wake)),
    );
  }
  update(metadata: Record<string, string>): AgentSession {
    const record = this.record();
    const next = { ...record, session: { ...record.session, metadata } };
    this.save(next);
    return next.session;
  }
  items(query: PageQuery) {
    this.record();
    return this.db.list(SessionKinds.item, query);
  }
  turns(query: PageQuery) {
    const record = this.record();
    return this.db.list(SessionKinds.turn, query, {
      field: "agent_id",
      value: record.session.agent.id,
    });
  }
  turn(id: string): Turn {
    this.record();
    return this.tx.requireTurn(id);
  }
  subagents(query: PageQuery) {
    this.record();
    return this.db.list(SessionKinds.subagent, query);
  }
  subagent(id: string): Subagent {
    this.record();
    return this.db.require(SessionKinds.subagent, id);
  }
  subagentItems(id: string, query: PageQuery, turnId?: string) {
    this.subagent(id);
    if (turnId) this.subagentTurn(id, turnId);
    return this.db.list(
      SessionKinds.subagentItem(id),
      query,
      turnId ? { field: "turn_id", value: turnId } : undefined,
    );
  }
  subagentTurns(id: string, query: PageQuery) {
    this.subagent(id);
    return this.db.list(SessionKinds.turn, query, { field: "agent_id", value: id });
  }
  subagentTurn(id: string, turnId: string): Turn {
    this.subagent(id);
    const turn = this.turn(turnId);
    if (turn.subagent_id !== id) throw new ApiError(404, "not_found", "Subagent turn not found");
    return turn;
  }
  artifacts(query: PageQuery, environmentId?: string) {
    this.record();
    const page = this.db.list(
      SessionKinds.artifact,
      query,
      environmentId ? { field: "environment_id", value: environmentId } : undefined,
    );
    return { ...page, data: page.data.map(({ key: _key, ...resource }) => resource) };
  }
  artifact(id: string): ArtifactRecord {
    this.record();
    return this.db.require(SessionKinds.artifact, id);
  }
  deleteArtifact(id: string): string {
    const artifact = this.artifact(id);
    this.db.remove(SessionKinds.artifact, id);
    return artifact.key;
  }
  replay(after: number) {
    this.record();
    return this.db.events(after);
  }
  /** Committed state only: an active turn has no consistent checkpoint yet. */
  forkSource(): string {
    return runSync(
      encodeRpc(
        ForkSourceResult,
        attempt("session.forkSource", () => this.source()),
      ),
      "session.forkSource",
    );
  }
  private source(): ForkSource {
    const record = this.record();
    if (record.execution)
      throw new ApiError(409, "active_turn", "Wait for the current turn to stop before forking");
    // Pages are folded into the bounded transcript as they are read, never held together.
    const transcript = new TranscriptBuilder();
    let after: string | undefined;
    do {
      const page = this.db.list(SessionKinds.item, { order: "asc", limit: 100, after });
      transcript.add(page.data);
      after = page.has_more ? (page.last_id ?? undefined) : undefined;
    } while (after);
    const lastTurn = this.db.list(SessionKinds.turn, { order: "desc", limit: 1 }).data[0];
    return {
      session: record.session,
      agent: record.agent,
      driver: record.driver,
      revision: record.revision,
      model: record.model,
      checkpoint: record.checkpoint,
      ...(record.environmentSpec ? { environmentSpec: record.environmentSpec } : {}),
      lastTurnId: lastTurn?.id ?? null,
      transcript: transcript.render(),
    };
  }

  submit(events: InputEvent[], key: string): Promise<typeof SubmitResult.Encoded> {
    return this.run(
      encodeRpc(SubmitResult, submitProgram(events, key).pipe(Effect.zipLeft(this.wake))),
    );
  }
  private active(): boolean {
    return !!this.db.get(SessionKinds.state, "session")?.execution;
  }
  override alarm(): Promise<void> {
    return this.run(this.alarmProgram());
  }
  /**
   * The platform clears a fired alarm. While a turn is active, re-arm before the permit
   * check so a busy reconciler cannot consume the only wake-up; the tick then runs under
   * the object's single permit and re-arms again once it settles.
   */
  private alarmProgram() {
    return Effect.gen(this, function* () {
      const alarm = yield* Alarm;
      const drivers = yield* Drivers;
      const arm = Effect.suspend(() =>
        this.active() ? alarm.arm(drivers.pollIntervalMs).pipe(Effect.orDie) : Effect.void,
      );
      const tick = reconcileTick().pipe(
        Effect.catchAllCause((cause) => Effect.logError("Session reconciliation failed", cause)),
        Effect.ensuring(this.wake.pipe(Effect.zipRight(arm))),
      );
      yield* arm;
      yield* this.reconciliation.withPermitsIfAvailable(1)(tick);
    }).pipe(Effect.asVoid);
  }
  delete(): Promise<Deleted> {
    return this.run(
      Effect.flatMap(Repo, (repo) => repo.transaction(markDeleted)).pipe(
        Effect.tap(() => this.close),
      ),
    );
  }
  purge(): Promise<void> {
    return this.run(
      Effect.gen(this, function* () {
        const repo = yield* Repo;
        if (!(yield* repo.transaction(purgeRecords))) return;
        yield* this.close;
        yield* (yield* Alarm).clear;
      }),
    );
  }
  stream(after?: number, options: { initial?: boolean } = {}): Response {
    this.record();
    if (this.listeners.size >= 64)
      throw new ApiError(429, "stream_limit", "Too many live streams for this session");
    const cursor = after ?? this.db.lastEvent();
    let controller: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>(
      {
        start: (value) => {
          controller = value;
          this.listeners.set(value, { cursor, initial: options.initial ?? false });
          this.watch();
          this.flush();
        },
        pull: () => this.flush(),
        cancel: () => this.detach(controller),
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
  /** Keepalive comments keep idle proxies from closing a stream while a turn is quiet. */
  private watch(): void {
    if (this.keepalive || !this.listeners.size) return;
    const encoded = new TextEncoder().encode(": keepalive\n\n");
    this.keepalive = setInterval(() => {
      for (const listener of this.listeners.keys())
        if ((listener.desiredSize ?? 0) > 0) listener.enqueue(encoded);
    }, this.dependencies().keepaliveMs ?? 15_000);
  }
  private detach(controller: ReadableStreamDefaultController<Uint8Array>): void {
    this.listeners.delete(controller);
    if (this.listeners.size || !this.keepalive) return;
    clearInterval(this.keepalive);
    this.keepalive = undefined;
  }
  private closeListener(controller: ReadableStreamDefaultController<Uint8Array>): void {
    try {
      controller.close();
    } catch {
      // The consumer already went away; nothing is left to close.
    }
    this.detach(controller);
  }
  private closeListeners(): void {
    for (const listener of this.listeners.keys()) this.closeListener(listener);
  }
  /** A creation stream covers the initial turn only, or nothing when no input was given. */
  private initialSettled(event: AgentSessionEvent): boolean {
    if (event.type === "agent.session.idle" || event.type === "agent.session.failed") return true;
    if (event.type !== "agent.session.created") return false;
    return (
      !this.active() &&
      this.db.list(SessionKinds.turn, { order: "asc", limit: 1 }).data.length === 0
    );
  }
  private flush(): void {
    // enqueue() can call pull() synchronously; a nested flush must not re-read events.
    if (this.flushing) return;
    this.flushing = true;
    try {
      for (const [listener, state] of this.listeners) {
        if ((listener.desiredSize ?? 0) <= 0) continue;
        const entries = this.db.events(state.cursor, 64);
        for (const { seq, event } of entries) {
          if ((listener.desiredSize ?? 0) <= 0) break;
          state.cursor = seq;
          listener.enqueue(
            new TextEncoder().encode(
              `id: ${seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
            ),
          );
          if (state.initial && this.initialSettled(event)) {
            this.closeListener(listener);
            break;
          }
        }
      }
    } finally {
      this.flushing = false;
    }
  }
}
