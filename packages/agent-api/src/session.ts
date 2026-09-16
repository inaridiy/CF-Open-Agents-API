import { DurableObject } from "cloudflare:workers";
import {
  Clock,
  type Context,
  Deferred,
  Duration,
  Effect,
  Exit,
  FiberId,
  Option,
  PubSub,
  Queue,
  Schedule,
  Schema,
  Stream,
} from "effect";
import type { AgentSessionEnvironmentState, Subagent } from "openai/resources/beta/agents/agents";

import { attempt, runSync, settle } from "./effect.js";
import type { EnvironmentSpec } from "./environments.js";
import {
  encodeRpc,
  ExecutorVersionIncompatible,
  rpcEnvelope,
  type StorageFailure,
  StreamLimitExceeded,
  SubagentTurnMismatch,
  TurnActive,
} from "./errors.js";
import { SessionKinds } from "./persistence/session-kinds.js";
import { type ArtifactRecord, migrate, type SessionRecord } from "./persistence/session-record.js";
import {
  makeSessionRepo,
  type SessionRepo,
  type SessionTxError,
} from "./persistence/session-repo.js";
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
import { identifier } from "./protocol.js";
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

export type {
  ActiveSession,
  ArtifactRecord,
  Fenced,
  SessionRecord,
} from "./persistence/session-record.js";
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
/** Text parts verbatim, images as a placeholder, anything else (files, refusals) omitted. */
function transcriptPart(
  part: Extract<AgentSessionItem, { type: "message" }>["content"][number],
): string {
  if (part.type === "input_text" || part.type === "output_text") return part.text;
  return part.type === "input_image" ? "[image]" : "";
}
function transcriptEntry(item: AgentSessionItem): string | undefined {
  switch (item.type) {
    case "message": {
      const text = item.content.map(transcriptPart).join("\n");
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
    throw new ExecutorVersionIncompatible({ harness: record.driver, revision: record.revision });
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
/** Live SSE listeners per session object; the 65th request is refused with `stream_limit`. */
const LISTENER_LIMIT = 64;
/** Events a listener reads from SQLite per pull; the ReadableStream queue bounds the bytes. */
const EVENT_PAGE = 64;
const SSE_HEADERS = {
  "content-type": "text/event-stream",
  "cache-control": "no-cache",
  "x-accel-buffering": "no",
};
const frame = ({ seq, event }: { seq: number; event: AgentSessionEvent }) =>
  `id: ${seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
const KEEPALIVE = ": keepalive\n\n";
/**
 * Every commit through the repository wakes the live streams. The wake is a sliding
 * `PubSub` of capacity one: publishing never suspends, and a listener that lagged sees at
 * most one pending tick, which is enough because it reads events from SQLite by cursor.
 */
const wakeAfterCommit = (repo: SessionRepo, wake: PubSub.PubSub<void>): SessionRepo => ({
  transaction: (f) => repo.transaction(f).pipe(Effect.tap(() => PubSub.publish(wake, void 0))),
  read: repo.read,
});
export class SessionObject<Env = unknown> extends DurableObject<Env> {
  /** The durable store; tests read it through `SessionKinds`. */
  readonly db = new SqlStore(this.ctx.storage);
  /** Synchronous typed view for the plain RPC reads. */
  private readonly tx: SessionTx = makeSessionTx(this.db);
  /** Post-commit wake for live streams; see `wakeAfterCommit`. */
  // lint: entrypoint
  private readonly wake = runSync(PubSub.sliding<void>(1), "session.wake");
  /** Effect edge of the seam: one `transactionSync` per `transaction`, then a wake. */
  private readonly repo: SessionRepo = wakeAfterCommit(
    makeSessionRepo(this.db, this.ctx.storage),
    this.wake,
  );
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
  /** One permit per live stream, held by the stream's scope until it ends or is cancelled. */
  private readonly listeners = Effect.unsafeMakeSemaphore(LISTENER_LIMIT);
  /** Completed by `delete` and `purge`: every live stream ends, as the listeners did before. */
  private readonly closed = Deferred.unsafeMake<void>(FiberId.none);
  protected dependencies(): SessionDependencies {
    throw new Error("SessionObject must be configured through createAgentService");
  }
  /** Boundary runner: a failure is thrown as itself so its RPC wire name survives. */
  private run<A, E>(program: Effect.Effect<A, E, SessionServices>): Promise<A> {
    // lint: entrypoint
    return this.runtime.runPromiseExit(program).then(settle);
  }
  private readonly close = Deferred.done(this.closed, Exit.void);
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
    // The one synchronous wake: this entrypoint is plain, and publishing to a sliding
    // PubSub never suspends, so `runSync` cannot leave a fiber behind.
    // lint: entrypoint
    runSync(PubSub.publish(this.wake, void 0), "session.wake");
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
      Effect.flatMap(Repo, (repo) => repo.transaction((tx) => applyEnvironmentStatus(tx, status))),
    );
  }
  /**
   * Unfenced by design: the read and the write are one synchronous step of a serialized
   * RPC call, so no reconciler transaction can move the record on in between, and a fenced
   * transition that follows re-reads the metadata from the store rather than from its own
   * earlier read.
   */
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
    if (turn.subagent_id !== id) throw new SubagentTurnMismatch({ subagentId: id, turnId });
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
    // lint: entrypoint
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
    if (record.execution) throw new TurnActive({ action: "fork" });
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
    return this.run(encodeRpc(SubmitResult, submitProgram(events, key)));
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
   * the object's single permit and re-arms once it settles, for one interval after this
   * alarm fired, or at once when the tick (a long poll, a slow start) outlasted it.
   */
  private alarmProgram() {
    return Effect.gen(this, function* () {
      const alarm = yield* Alarm;
      const drivers = yield* Drivers;
      const started = yield* Clock.currentTimeMillis;
      const arm = (inMs: number) =>
        Effect.suspend(() => (this.active() ? alarm.arm(inMs).pipe(Effect.orDie) : Effect.void));
      const rearm = Clock.currentTimeMillis.pipe(
        Effect.flatMap((now) => arm(Math.max(0, started + drivers.pollIntervalMs - now))),
      );
      const tick = reconcileTick().pipe(
        Effect.catchAllCause((cause) => Effect.logError("Session reconciliation failed", cause)),
        Effect.ensuring(rearm),
      );
      yield* arm(drivers.pollIntervalMs);
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
  /**
   * Server-sent events from `after` (default: the current tail) as a `Stream` run by the
   * object's runtime. The ReadableStream owns the fiber: back-pressure is its 64 KiB
   * queue, and cancelling it (the client went away) interrupts the fiber, which releases
   * the listener permit and the wake subscription through their scope.
   */
  stream(after?: number, options: { initial?: boolean } = {}): Response {
    this.record();
    // The cap is checked here, synchronously, and the permit is held by the stream's scope.
    // RPC serializes calls to this object, so the stream's fiber (which starts on the next
    // task) takes the permit the probe saw. The probe takes and releases without suspending.
    // lint: entrypoint
    const free = runSync(this.listeners.withPermitsIfAvailable(1)(Effect.void), "session.stream");
    if (Option.isNone(free)) throw new StreamLimitExceeded({ limit: LISTENER_LIMIT });
    // The stream's fiber starts on the object's runtime; obtaining it is synchronous once
    // the layers are built, and they hold no resources.
    // lint: entrypoint
    const runtime = this.runtime.runSync(this.runtime.runtimeEffect);
    const body = Stream.toReadableStreamRuntime(
      this.events(after ?? this.db.lastEvent(), !!options.initial),
      runtime,
      { strategy: { highWaterMark: 64 * 1024, size: (chunk) => chunk.byteLength } },
    );
    return new Response(body, { headers: SSE_HEADERS });
  }
  /**
   * One listener: pages of events read from SQLite by cursor, pulled on demand and woken
   * by commits, merged with a keepalive comment while the turn is quiet. A creation
   * stream ends when the initial turn settles, or right after `created` without input.
   */
  private events(
    cursor: number,
    initial: boolean,
  ): Stream.Stream<Uint8Array, SessionTxError | StorageFailure, Drivers> {
    return Stream.unwrapScoped(
      Effect.gen(this, function* () {
        yield* Effect.acquireRelease(this.listeners.take(1), () => this.listeners.release(1));
        const drivers = yield* Drivers;
        // Subscribed before the first read: a commit between a read and the wait is not missed.
        const ticks = yield* PubSub.subscribe(this.wake);
        const page = (after: number) =>
          Effect.gen(this, function* () {
            let rows = yield* this.repo.read((tx) => tx.store.events(after, EVENT_PAGE));
            while (rows.length === 0) {
              yield* Queue.take(ticks);
              rows = yield* this.repo.read((tx) => tx.store.events(after, EVENT_PAGE));
            }
            return [rows, Option.some(rows.at(-1)?.seq ?? after)] as const;
          });
        const events = Stream.paginateEffect(cursor, page).pipe(
          Stream.flattenIterables,
          Stream.takeUntilEffect(({ event }) =>
            initial ? this.initialSettled(event) : Effect.succeed(false),
          ),
          Stream.map(frame),
        );
        const keepalive = Stream.fromSchedule(
          Schedule.spaced(Duration.millis(drivers.keepaliveMs)),
        ).pipe(Stream.as(KEEPALIVE));
        return Stream.merge(events, keepalive, { haltStrategy: "left" }).pipe(
          Stream.interruptWhen(Deferred.await(this.closed)),
          // One event per chunk, so the queue's byte budget is checked before each one.
          Stream.rechunk(1),
          Stream.encodeText,
        );
      }),
    );
  }
  /** A creation stream covers the initial turn only, or nothing when no input was given. */
  private initialSettled(event: AgentSessionEvent) {
    if (event.type === "agent.session.idle" || event.type === "agent.session.failed")
      return Effect.succeed(true);
    if (event.type !== "agent.session.created") return Effect.succeed(false);
    return this.repo.read(
      (tx) =>
        !tx.store.get(SessionKinds.state, "session")?.execution &&
        tx.store.list(SessionKinds.turn, { order: "asc", limit: 1 }).data.length === 0,
    );
  }
}
