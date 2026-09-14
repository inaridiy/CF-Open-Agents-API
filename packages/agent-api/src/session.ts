import { DurableObject } from "cloudflare:workers";
import { Context, Effect, Either, Layer, Schema } from "effect";
import type {
  AgentSessionEnvironmentState,
  SessionTurnError,
  Subagent,
} from "openai/resources/beta/agents/agents";
import type { SessionArtifact } from "openai/resources/beta/agents/sessions/artifacts";

import { attempt, io, runPromise } from "./effect.js";
import type { EnvironmentSpec } from "./environments.js";
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
import {
  ApiError,
  assertImageLimit,
  canonicalJSON,
  identifier,
  type RpcResult,
  remoteImageURLs,
  rpcFailure,
} from "./protocol.js";
import {
  type AgentRegistration,
  type Checkpoint,
  type Execution,
  executionSchema,
  type RuntimeCommand,
  type RuntimeDriver,
} from "./runtime.js";
import { acceptRuntimeEvent, finishOutputItems, recordToolResult } from "./session-events.js";
import { SqlStore } from "./storage.js";

export interface ArtifactRecord extends SessionArtifact {
  key: string;
}

interface SessionBase {
  readonly schemaVersion?: 2;
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
  readonly environmentSpec?: EnvironmentSpec;
  /** Set by a fork whose native history could not be carried; consumed by the next completed turn. */
  readonly inheritedTranscript?: string;
  readonly forkedFrom?: { sessionId: string; turnId: string | null };
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
export function transcriptMessage(transcript: string): InputMessage {
  return {
    role: "user",
    content: [
      {
        type: "input_text",
        text: `The following is the transcript of this session before it was forked to a different runtime. Treat it as prior conversation history, then continue with the request that follows.\n\n<transcript>\n${transcript}\n</transcript>`,
      },
    ],
  };
}
interface Command {
  id: string;
  turnId: string;
  command: RuntimeCommand;
  /** Input items added for a steer; removed if the executor never received the steer. */
  itemIds?: string[];
}
/** Steer input the executor rejected after the fact; it runs as the next turn. */
interface QueuedInput {
  input: InputMessage[];
}
interface Listener {
  cursor: number;
  /** A creation stream ends once the initial turn settles or when there is no input. */
  initial: boolean;
}
/** Failure categories the SDK's turn error type can carry verbatim. */
const TURN_ERROR_CODES = new Set<SessionTurnError["code"]>([
  "context_length_exceeded",
  "session_budget_exceeded",
  "usage_limit_exceeded",
  "rate_limit_exceeded",
  "server_overloaded",
  "cyber_policy",
  "connection_failed",
  "server_error",
  "authentication_error",
  "invalid_request",
  "resource_not_found",
  "sandbox_error",
  "executor_version_incompatible",
  "active_turn_not_steerable",
  "request_timeout",
  "internal_error",
]);
/** Only an outcome nobody can confirm leaves the session failed; other turns return to idle. */
export function isIndeterminate(error: string | undefined): boolean {
  return error === "outcome_unknown" || (error?.endsWith("_uncertain") ?? false);
}
export interface SessionDependencies {
  drivers: Record<string, RuntimeDriver>;
  /** Deployment presets, used to resolve delegation targets when subagents are enabled. */
  agents?: Record<string, AgentRegistration>;
  maxTurnMs: number;
  pollIntervalMs: number;
  /** Interval of SSE keepalive comments while live streams exist. */
  keepaliveMs?: number;
}

class Reconciliation extends Context.Tag("agent-api/Reconciliation")<
  Reconciliation,
  SessionDependencies
>() {}

export class SessionObject<Env = unknown> extends DurableObject<Env> {
  readonly db: SqlStore;
  private readonly reconciliation = Effect.unsafeMakeSemaphore(1);
  private readonly listeners = new Map<ReadableStreamDefaultController<Uint8Array>, Listener>();
  private keepalive: ReturnType<typeof setInterval> | undefined;
  private flushing = false;
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
    let migrated = record;
    this.db.transaction(() => {
      migrated = this.migrate(record);
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
    const original = this.db.require<SessionRecord>("state", "session");
    const record = this.migrate(original);
    this.validate(record);
    if (record !== original) this.save(record);
    if (record.deleted) throw new ApiError(404, "not_found", "Session not found");
    return record;
  }
  private migrate(record: SessionRecord): SessionRecord {
    if (record.schemaVersion === 2) return record;
    if (record.schemaVersion !== undefined)
      throw new ApiError(409, "invalid_session_state", "Unsupported session record version");
    // Alpha records stored the response-only null limit in request configuration.
    const agent = (config: AgentConfig): AgentConfig => ({
      ...config,
      ...(config.multi_agent
        ? {
            multi_agent: {
              enabled: config.multi_agent.enabled,
              ...(config.multi_agent.max_concurrent_subagents != null
                ? { max_concurrent_subagents: config.multi_agent.max_concurrent_subagents }
                : {}),
            },
          }
        : {}),
    });
    const base = { ...record, schemaVersion: 2 as const, agent: agent(record.agent) };
    return record.execution
      ? {
          ...base,
          phase: record.phase,
          execution: { ...record.execution, agent: agent(record.execution.agent) },
        }
      : { ...base, phase: record.phase, execution: null };
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
  environmentStatus(status: AgentSessionEnvironmentState["status"]): void {
    this.db.transaction(() => {
      const record = this.record();
      if (record.session.environment.type === "none") return;
      const current = this.db.get<string>("environment", "status");
      if (current === status) return;
      // A creation retry reports pending again; a settled environment never regresses.
      if (status === "pending" && current !== undefined) return;
      // Only a connected sandbox can disconnect, and a failed setup never reconnects.
      if (status === "disconnected" && current !== "connected") return;
      if (status === "connected" && current === "failed") return;
      this.db.put("environment", "status", status);
      this.emit({
        type: `agent.session.environment.${status}`,
        event_id: identifier("evt"),
        session_id: record.session.id,
        turn_id: record.execution?.turnId ?? null,
        environment: {
          id: record.session.environment.id,
          type: record.session.environment.type,
          status,
          error:
            status === "failed"
              ? {
                  code: "environment_setup_failed",
                  type: "environment_error",
                  message: "Environment setup failed",
                }
              : null,
        },
      });
      if (status === "failed" && !record.execution) {
        const next: SessionRecord = {
          ...record,
          phase: "failed",
          execution: null,
          session: { ...record.session, status: "failed", error: "environment_setup_failed" },
        };
        this.save(next);
        this.emit({
          type: "agent.session.failed",
          event_id: identifier("evt"),
          session: next.session,
        });
      }
    });
    this.flush();
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
    const record = this.record();
    return this.db.list<Turn>("turn", query, { field: "agent_id", value: record.session.agent.id });
  }
  turn(id: string): Turn {
    this.record();
    return this.db.require<Turn>("turn", id);
  }
  subagents(query: PageQuery) {
    this.record();
    return this.db.list<Subagent>("subagent", query);
  }
  subagent(id: string): Subagent {
    this.record();
    return this.db.require<Subagent>("subagent", id);
  }
  subagentItems(id: string, query: PageQuery, turnId?: string) {
    this.subagent(id);
    if (turnId) this.subagentTurn(id, turnId);
    return this.db.list<AgentSessionItem>(
      `subagent_item:${id}`,
      query,
      turnId ? { field: "turn_id", value: turnId } : undefined,
    );
  }
  subagentTurns(id: string, query: PageQuery) {
    this.subagent(id);
    return this.db.list<Turn>("turn", query, { field: "agent_id", value: id });
  }
  subagentTurn(id: string, turnId: string): Turn {
    this.subagent(id);
    const turn = this.turn(turnId);
    if (turn.subagent_id !== id) throw new ApiError(404, "not_found", "Subagent turn not found");
    return turn;
  }
  artifacts(query: PageQuery, environmentId?: string) {
    this.record();
    const page = this.db.list<ArtifactRecord>(
      "artifact",
      query,
      environmentId ? { field: "environment_id", value: environmentId } : undefined,
    );
    return { ...page, data: page.data.map(({ key: _key, ...resource }) => resource) };
  }
  artifact(id: string): ArtifactRecord {
    this.record();
    return this.db.require<ArtifactRecord>("artifact", id);
  }
  deleteArtifact(id: string): string {
    const artifact = this.artifact(id);
    this.db.remove("artifact", id);
    return artifact.key;
  }
  replay(after: number) {
    this.record();
    return this.db.events<AgentSessionEvent>(after);
  }
  /**
   * Committed state only: an active turn has no consistent checkpoint yet.
   * Serialized because the RPC type of the public session shape is too deep.
   */
  forkSource(): string {
    try {
      return JSON.stringify({ ok: true, value: this.source() } satisfies RpcResult<ForkSource>);
    } catch (error) {
      return JSON.stringify(rpcFailure(error));
    }
  }
  private source(): ForkSource {
    const record = this.record();
    if (record.execution)
      throw new ApiError(409, "active_turn", "Wait for the current turn to stop before forking");
    // Pages are folded into the bounded transcript as they are read, never held together.
    const transcript = new TranscriptBuilder();
    let after: string | undefined;
    do {
      const page = this.db.list<AgentSessionItem>("item", { order: "asc", limit: 100, after });
      transcript.add(page.data);
      after = page.has_more ? (page.last_id ?? undefined) : undefined;
    } while (after);
    const lastTurn = this.db.list<Turn>("turn", { order: "desc", limit: 1 }).data[0];
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
            const images = new Set<string>();
            for (const event of events) {
              if (event.type === "agent.session.input.message")
                remoteImageURLs(
                  event.input.flatMap((message) => message.content),
                  images,
                );
              else if (
                event.type === "agent.session.input.tool_result" &&
                Array.isArray(event.output)
              )
                remoteImageURLs(event.output, images);
            }
            assertImageLimit(images);
            for (const event of events) {
              switch (event.type) {
                case "agent.session.input.message": {
                  if (
                    !driver.capabilities.images &&
                    event.input.some((message) =>
                      message.content.some((part) => part.type === "input_image"),
                    )
                  )
                    throw new ApiError(
                      422,
                      "unsupported_capability",
                      "The selected harness does not support image input",
                    );
                  if (record.execution) {
                    if (!driver.capabilities.steer)
                      throw new ApiError(
                        409,
                        "active_turn_not_steerable",
                        "This harness cannot steer an active turn",
                      );
                    const itemIds = this.addInput(record, event.input);
                    this.enqueue(record, { type: "steer", input: event.input }, itemIds);
                  } else {
                    record = this.begin(record, event.input);
                    this.addInput(record, event.input);
                  }
                  break;
                }
                case "agent.session.input.cancel":
                  if (record.execution) this.enqueue(record, { type: "cancel" });
                  break;
                case "agent.session.input.tool_result": {
                  if (
                    !driver.capabilities.images &&
                    Array.isArray(event.output) &&
                    event.output.some((part) => part.type === "input_image")
                  )
                    throw new ApiError(
                      422,
                      "unsupported_capability",
                      "The selected harness does not support image function results",
                    );
                  const action = record.session.required_actions.find(
                    (action) =>
                      action.type === "function_call" &&
                      action.call_id === event.call_id &&
                      action.turn_id === event.turn_id,
                  );
                  // The official SDK retries a tool result submitted before the call was
                  // registered only when the response is a 400 whose `code` is
                  // `invalid_request_error` and whose message is exactly this text
                  // (openai/lib/agents/agent-session-stream.js, `#submit`). Keep both.
                  if (!action || !record.execution)
                    throw new ApiError(
                      400,
                      "invalid_request_error",
                      `Unknown pending tool call: ${event.call_id}`,
                    );
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
            // Accepted input counts as activity even when it only queues a command.
            record = {
              ...record,
              session: { ...record.session, last_active_at: Math.floor(Date.now() / 1_000) },
            };
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
  /** Presets the deployment allows this session's preset to delegate to. */
  private delegates(record: SessionRecord): Execution["delegates"] {
    if (!record.agent.multi_agent?.enabled) return undefined;
    const agents = this.dependencies().agents ?? {};
    const targets = (agents[record.session.agent.model]?.delegates ?? []).flatMap((alias) => {
      const target = agents[alias];
      return target ? [{ alias, harness: target.harness, model: target.model }] : [];
    });
    return targets.length ? targets : undefined;
  }
  private begin(record: SessionRecord, input: InputMessage[]): ActiveSession {
    const now = Math.floor(Date.now() / 1_000);
    const id = identifier("turn");
    const delegates = this.delegates(record);
    const next: ActiveSession = {
      ...record,
      generation: record.generation + 1,
      execution: {
        sessionId: record.session.id,
        tenant: record.tenant,
        vaultIds: record.session.vault_ids,
        turnId: id,
        generation: record.generation + 1,
        agent: record.agent,
        harness: record.driver,
        model: record.model,
        input: record.inheritedTranscript
          ? [transcriptMessage(record.inheritedTranscript), ...input]
          : input,
        checkpoint: record.checkpoint,
        deadline: Date.now() + this.dependencies().maxTurnMs,
        sandbox: record.session.environment.type !== "none",
        ...(record.session.environment.type !== "none"
          ? { environmentId: record.session.environment.id }
          : {}),
        ...(delegates
          ? {
              delegates,
              maxConcurrentSubagents: record.agent.multi_agent?.max_concurrent_subagents ?? 6,
            }
          : {}),
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
  private addInput(record: ActiveSession, input: InputMessage[]): string[] {
    const ids: string[] = [];
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
      ids.push(item.id);
      this.emit({
        type: "agent.session.turn.item.added",
        event_id: identifier("evt"),
        session_id: record.session.id,
        turn_id: record.execution.turnId,
        output_index: null,
        item,
      });
    }
    return ids;
  }
  private enqueue(record: ActiveSession, command: RuntimeCommand, itemIds?: string[]): void {
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
    this.db.put("command", id, {
      id,
      turnId: record.execution.turnId,
      command,
      ...(itemIds ? { itemIds } : {}),
    } satisfies Command);
  }
  /** The executor refused a queued command for good. A steer's input becomes the next turn. */
  private reject(operation: Command): void {
    this.db.remove("command", operation.id);
    if (operation.command.type !== "steer") return;
    for (const itemId of operation.itemIds ?? []) this.db.remove("item", itemId);
    this.db.put("queued_input", operation.id, {
      input: operation.command.input,
    } satisfies QueuedInput);
  }
  private active(): boolean {
    return !!this.db.get<SessionRecord>("state", "session")?.execution;
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
          if (this.active()) yield* arm.pipe(Effect.orDie);
        }),
      ),
    );
    return runPromise(
      Effect.gen(this, function* () {
        // The platform clears a fired alarm. While a turn is active, re-arm before the
        // permit check so a busy reconciler cannot consume the only wake-up.
        if (this.active()) yield* arm.pipe(Effect.orDie);
        yield* this.reconciliation.withPermitsIfAvailable(1)(reconcile);
      }).pipe(Effect.asVoid, Effect.provide(Layer.succeed(Reconciliation, this.dependencies()))),
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
      if (!driver) {
        // The deployment no longer registers this executor: nothing can poll or stop it,
        // and polling forever would only burn alarms.
        yield* this.finish(execution, "failed", "executor_unavailable");
        return;
      }
      const stopAndFail = (code: string) =>
        driver
          .stop(execution)
          .pipe(Effect.zipRight(this.finish(execution, "failed", code)), Effect.asVoid);
      if (driver.revision !== initial.revision) {
        yield* stopAndFail("executor_version_incompatible");
        return;
      }
      // Once completion is durable, recover the checkpoint directly, even if compute vanished.
      if (initial.phase === "checkpointing") {
        yield* this.checkpoint(driver, execution);
        return;
      }
      if (Date.now() >= execution.deadline) {
        yield* stopAndFail("request_timeout");
        return;
      }
      if (initial.phase === "starting") {
        const started = yield* driver
          .start(execution, `${execution.turnId}:start`)
          .pipe(Effect.either);
        if (Either.isLeft(started)) {
          // A typed rejection is permanent; an I/O failure is retried until the deadline.
          if (started.left._tag !== "ApiError") return yield* Effect.fail(started.left);
          yield* stopAndFail(started.left.code);
          return;
        }
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
          yield* stopAndFail("request_timeout");
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
        // Delivery never blocks the poll: a refused command is dropped (a steer's input
        // is queued for the next turn) and an unknown delivery outcome is retried after
        // polling, so a turn the runtime already finished can still be sealed.
        let retryDelivery = false;
        for (const operation of commands) {
          if (!this.current(execution)) return;
          if (operation.turnId !== execution.turnId) {
            if (!cancel)
              yield* this.transition(execution, () => this.db.remove("command", operation.id));
            continue;
          }
          const delivered = yield* driver
            .control(execution, operation.id, operation.command)
            .pipe(Effect.either);
          if (Either.isRight(delivered)) {
            if (!cancel)
              yield* this.transition(execution, () => this.db.remove("command", operation.id));
            continue;
          }
          if (cancel) {
            yield* Effect.logWarning(
              "Cancellation delivery failed; reconciling native outcome",
              delivered.left,
            );
          } else if (delivered.left._tag === "ApiError") {
            yield* Effect.logWarning("Executor refused a queued command", delivered.left);
            yield* this.transition(execution, () => this.reject(operation));
          } else {
            yield* Effect.logWarning("Command delivery failed; polling first", delivered.left);
            retryDelivery = true;
            break;
          }
        }
        const current = this.current(execution);
        if (!current) return;
        const batch = yield* driver.poll(execution, current.cursor);
        const accepted = yield* this.transition(execution, (record) => {
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
        }).pipe(Effect.either);
        if (Either.isLeft(accepted)) {
          // A protocol violation cannot be retried into success: stop and fail with its code.
          if (accepted.left._tag !== "ApiError") return yield* Effect.fail(accepted.left);
          yield* stopAndFail(accepted.left.code);
          return;
        }
        const phase = accepted.right;
        if (!phase) return;
        if (phase === "checkpointing") {
          yield* this.checkpoint(driver, execution);
          return;
        }
        if (batch.status === "failed" || batch.status === "missing") {
          yield* stopAndFail(
            batch.status === "missing" ? "outcome_unknown" : (batch.error ?? "executor_failed"),
          );
          return;
        }
        if (batch.status === "cancelled") {
          yield* driver.stop(execution);
          yield* this.finish(execution, "cancelled");
          return;
        }
        if (phase !== "commands" || retryDelivery) return;
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
        for (const artifact of checkpoint.artifacts ?? [])
          this.db.put("artifact", artifact.id, {
            ...artifact,
            object: "agent.session.artifact",
          } satisfies ArtifactRecord);
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
    const turnError: SessionTurnError | null = error
      ? {
          code: TURN_ERROR_CODES.has(error as SessionTurnError["code"])
            ? (error as SessionTurnError["code"])
            : "internal_error",
          message: error,
        }
      : null;
    const indeterminate = status === "failed" && isIndeterminate(error);
    let after: string | undefined;
    do {
      const page = this.db.list<Turn>(status === "completed" ? "pending_subagent_turn" : "turn", {
        order: "asc",
        limit: 100,
        after,
      });
      for (const pending of page.data) {
        if (
          status !== "completed" &&
          (!pending.subagent_id || !["in_progress", "waiting"].includes(pending.status))
        )
          continue;
        const child: Turn =
          status === "completed"
            ? pending
            : {
                ...pending,
                status,
                completed_at: Math.floor(Date.now() / 1000),
                error: turnError,
              };
        this.db.put("turn", child.id, child);
        finishOutputItems(this.db, record, child.id, `subagent_item:${child.subagent_id}`);
        this.emit({
          type: `agent.session.turn.${status}`,
          event_id: identifier("evt"),
          session_id: record.session.id,
          turn_id: child.id,
          turn: child,
          usage: child.usage,
        });
      }
      after = page.has_more ? (page.last_id ?? undefined) : undefined;
    } while (after);
    this.db.clear("pending_subagent_turn");
    const turn: Turn = {
      ...this.turn(record.execution.turnId),
      status,
      completed_at: Math.floor(Date.now() / 1000),
      error: turnError,
    };
    this.db.put("turn", turn.id, turn);
    finishOutputItems(this.db, record, turn.id, "item");
    this.db.clear("command");
    this.db.clear("cancellation");
    // A completed checkpoint now carries the inherited history natively.
    const { inheritedTranscript: _transcript, ...retained } = record;
    const next: SessionRecord = {
      ...(status === "completed" ? retained : record),
      execution: null,
      phase: indeterminate ? "failed" : "idle",
      session: {
        ...record.session,
        status: indeterminate ? "failed" : "idle",
        error: error ?? null,
        required_actions: [],
        last_active_at: Math.floor(Date.now() / 1_000),
      },
    };
    this.save(next);
    this.emit({
      type: `agent.session.turn.${status}`,
      event_id: identifier("evt"),
      session_id: record.session.id,
      turn_id: turn.id,
      turn,
      usage: turn.usage,
    });
    this.emit({
      type: indeterminate ? "agent.session.failed" : "agent.session.idle",
      event_id: identifier("evt"),
      session: next.session,
    });
    // Steer input the runtime refused was never processed: run it now. Cancellation
    // supersedes it, and an indeterminate session accepts no further input.
    const queued = this.db.list<QueuedInput>("queued_input", { order: "asc", limit: 100 }).data;
    this.db.clear("queued_input");
    if (!queued.length || status === "cancelled" || indeterminate) return;
    const input = queued.flatMap((entry) => entry.input);
    const started = this.begin(next, input);
    this.addInput(started, input);
    this.save(started);
  }
  async delete(): Promise<{ id: string; object: "agent.session.deleted"; deleted: true }> {
    const stored = this.db.get<SessionRecord>("state", "session");
    if (!stored) {
      // A purged object keeps only its tombstone, so a lost-response retry still succeeds.
      const tombstone = this.db.get<{ id: string }>("state", "tombstone");
      if (!tombstone) throw new ApiError(404, "not_found", "Session not found");
      return { id: tombstone.id, object: "agent.session.deleted", deleted: true };
    }
    const record = this.migrate(stored);
    if (record.execution)
      throw new ApiError(409, "active_turn", "Cancel the active turn before deleting the session");
    this.save({ ...record, deleted: true });
    this.closeListeners();
    return { id: record.session.id, object: "agent.session.deleted", deleted: true };
  }
  /** Drop every stored record once the catalog no longer discovers the session. Idempotent. */
  async purge(): Promise<void> {
    const record = this.db.get<SessionRecord>("state", "session");
    if (record && !record.deleted)
      throw new ApiError(409, "not_deleted", "Delete the session before purging its storage");
    const id = record?.session.id ?? this.db.get<{ id: string }>("state", "tombstone")?.id;
    if (!id) return;
    this.db.transaction(() => {
      this.db.purge();
      this.db.put("state", "tombstone", { id });
    });
    this.closeListeners();
    await this.ctx.storage.deleteAlarm();
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
      !this.active() && this.db.list<Turn>("turn", { order: "asc", limit: 1 }).data.length === 0
    );
  }
  private flush(): void {
    // enqueue() can call pull() synchronously; a nested flush must not re-read events.
    if (this.flushing) return;
    this.flushing = true;
    try {
      for (const [listener, state] of this.listeners) {
        if ((listener.desiredSize ?? 0) <= 0) continue;
        const entries = this.db.events<AgentSessionEvent>(state.cursor, 64);
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
