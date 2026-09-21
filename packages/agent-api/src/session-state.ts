import type {
  AgentSessionEnvironmentState,
  SessionTurnError,
} from "openai/resources/beta/agents/agents";

import {
  CapabilityUnsupported,
  CheckpointIncompatible,
  IdempotencyConflict,
  InvalidRuntimeEvent,
  SessionFailed,
  SessionNotDeleted,
  SessionNotFound,
  SteeringUnsupported,
  TurnActive,
  TurnCheckpointing,
  UnknownToolCall,
} from "./errors.js";
import { eachRecord } from "./persistence/record-store.js";
import { SessionKinds } from "./persistence/session-kinds.js";
import {
  type ActiveSession,
  type ArtifactRecord,
  type Command,
  type Fenced,
  migrate,
  type QueuedInput,
  type SessionRecord,
} from "./persistence/session-record.js";
import type { SessionTx } from "./persistence/session-tx.js";
import type { InputEvent, InputMessage, Turn } from "./protocol.js";
import {
  assertImageLimit,
  canonicalJSON,
  deleted,
  identifier,
  remoteImageURLs,
} from "./protocol.js";
import type {
  AgentRegistration,
  Checkpoint,
  Execution,
  RuntimeBatch,
  RuntimeCommand,
  RuntimeDriver,
} from "./runtime.js";
import { hostedWebSearch } from "./service-validation.js";
import { acceptRuntimeEvent, finishOutputItems, recordToolResult } from "./session-events.js";

/**
 * The session state machine: every transition is a synchronous, total function of a
 * `SessionTx` and runs inside one `transactionSync`. Nothing here performs I/O or waits;
 * a throw is the rollback and carries a tagged error the Effect edge classifies.
 *
 * Two kinds of transition write the session record. The input, environment and deletion
 * entrypoints read the record with `requireSession` and write it in the same synchronous
 * transaction, so what they read cannot go stale. The reconciler's transitions run after
 * the tick awaited the runtime, so they take a `Fenced<ActiveSession>`: the record as
 * `tx.fenced` re-read it in the writing transaction, matched to the execution. They derive
 * the next record from that value, and a stale execution never reaches them.
 */

/**
 * Failure categories the SDK's turn error type can carry verbatim. This is also the
 * vocabulary a supervisor may fail a turn with, so the list is exported and the
 * supervisor's `lifecycle.ts` re-exports it rather than keeping a second copy.
 */
export const TURN_ERROR_CODES = [
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
] as const satisfies readonly SessionTurnError["code"][];
export type TurnErrorCode = (typeof TURN_ERROR_CODES)[number];
const KNOWN_TURN_ERRORS: ReadonlySet<string> = new Set(TURN_ERROR_CODES);
/** Only an outcome nobody can confirm leaves the session failed; other turns return to idle. */
export function isIndeterminate(error: string | undefined): boolean {
  return error === "outcome_unknown" || (error?.endsWith("_uncertain") ?? false);
}
/** What starting a turn needs from the deployment. */
export interface TurnConfig {
  readonly maxTurnMs: number;
  readonly agents: Record<string, AgentRegistration>;
  /** Registered harnesses, so a delegate's hosted search is resolved from its own driver. */
  readonly harness?: (name: string) => RuntimeDriver | undefined;
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
/**
 * Presets the deployment allows this session's preset to delegate to. Each entry carries
 * the capabilities the child cannot re-derive: its tiers, and whether hosted search is
 * available on that target, decided here by the rule the session's own tools passed.
 */
function delegates(config: TurnConfig, record: SessionRecord): Execution["delegates"] {
  if (!record.agent.multi_agent?.enabled) return undefined;
  const agents = config.agents;
  const targets = (agents[record.session.agent.model]?.delegates ?? []).flatMap((alias) => {
    const target = agents[alias];
    return target
      ? [
          {
            alias,
            harness: target.harness,
            model: target.model,
            ...(target.tiers ? { tiers: target.tiers } : {}),
            webSearch: hostedWebSearch(target, config.harness?.(target.harness)),
          },
        ]
      : [];
  });
  return targets.length ? targets : undefined;
}
export function begin(
  tx: SessionTx,
  config: TurnConfig,
  record: SessionRecord,
  input: InputMessage[],
): ActiveSession {
  const now = Math.floor(Date.now() / 1_000);
  const id = identifier("turn");
  const targets = delegates(config, record);
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
      ...(record.tiers ? { tiers: record.tiers } : {}),
      input: record.inheritedTranscript
        ? [transcriptMessage(record.inheritedTranscript), ...input]
        : input,
      checkpoint: record.checkpoint,
      deadline: Date.now() + config.maxTurnMs,
      sandbox: record.session.environment.type !== "none",
      ...(record.session.environment.type !== "none"
        ? { environmentId: record.session.environment.id }
        : {}),
      ...(targets
        ? {
            delegates: targets,
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
  tx.putTurn(turn);
  tx.emit({
    event_id: identifier("evt"),
    type: "agent.session.turn.created",
    session_id: record.session.id,
    turn_id: id,
    turn,
  });
  tx.emit({
    event_id: identifier("evt"),
    type: "agent.session.in_progress",
    session: next.session,
  });
  return next;
}
export function addInput(tx: SessionTx, record: ActiveSession, input: InputMessage[]): string[] {
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
    tx.store.put(SessionKinds.item, item.id, item);
    ids.push(item.id);
    tx.emit({
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
export function enqueue(
  tx: SessionTx,
  record: ActiveSession,
  command: RuntimeCommand,
  itemIds?: string[],
): void {
  if (command.type === "cancel") {
    if (!tx.cancellation(record.execution.turnId))
      tx.store.put(SessionKinds.cancellation, record.execution.turnId, {
        id: identifier("op"),
        turnId: record.execution.turnId,
        command,
      } satisfies Command);
    return;
  }
  const id = identifier("op");
  tx.store.put(SessionKinds.command, id, {
    id,
    turnId: record.execution.turnId,
    command,
    ...(itemIds ? { itemIds } : {}),
  } satisfies Command);
}
/**
 * The executor took delivery of a queued command, or the command outlived its turn: drop
 * it. The fenced record is the witness that the queue belongs to a live execution.
 */
export function discard(tx: SessionTx, _fence: Fenced<ActiveSession>, operation: Command): void {
  tx.store.remove(SessionKinds.command, operation.id);
}
/** The executor refused a queued command for good. A steer's input becomes the next turn. */
export function reject(tx: SessionTx, record: Fenced<ActiveSession>, operation: Command): void {
  discard(tx, record, operation);
  if (operation.command.type !== "steer") return;
  for (const itemId of operation.itemIds ?? []) tx.store.remove(SessionKinds.item, itemId);
  tx.store.put(SessionKinds.queuedInput, operation.id, {
    input: operation.command.input,
  } satisfies QueuedInput);
}
/** The runtime acknowledged the start: the turn is in progress. */
export function markRunning(tx: SessionTx, record: Fenced<ActiveSession>): void {
  tx.save({ ...record, phase: "running" });
  const turn = {
    ...tx.requireTurn(record.execution.turnId),
    status: "in_progress" as const,
    started_at: Math.floor(Date.now() / 1000),
  };
  tx.putTurn(turn);
  tx.emit({
    type: "agent.session.turn.in_progress",
    event_id: identifier("evt"),
    session_id: record.execution.sessionId,
    turn_id: turn.id,
    turn,
  });
}
/**
 * Apply one polled batch. A protocol violation throws and rolls the whole batch back.
 * Returns `commands` when input accepted during the poll still awaits delivery,
 * otherwise the phase the record is now in.
 */
export function acceptBatch(
  tx: SessionTx,
  record: Fenced<ActiveSession>,
  batch: RuntimeBatch,
  cancel: Command | undefined,
): "commands" | ActiveSession["phase"] {
  let next = record;
  for (const entry of batch.events) {
    if (entry.seq <= next.cursor) continue;
    if (entry.seq !== next.cursor + 1)
      throw new InvalidRuntimeEvent({
        code: "invalid_runtime_cursor",
        message: "Runtime events must be contiguous",
      });
    next = { ...acceptRuntimeEvent(tx, next, entry.event), cursor: entry.seq };
  }
  // A command accepted during poll must be delivered before sealing completion.
  const pending = !cancel && tx.commands(1).length > 0;
  if (batch.status === "completed" && !pending) next = { ...next, phase: "checkpointing" };
  tx.save(next);
  return pending ? "commands" : next.phase;
}
/** The checkpoint is durable together with the artifacts and the terminal turn events. */
export function commitCheckpoint(
  tx: SessionTx,
  config: TurnConfig,
  record: Fenced<ActiveSession>,
  checkpoint: Checkpoint,
): void {
  if (checkpoint.driver !== record.driver || checkpoint.revision !== record.revision)
    throw new CheckpointIncompatible({
      message: "Checkpoint has an incompatible harness revision",
    });
  for (const artifact of checkpoint.artifacts ?? [])
    tx.store.put(SessionKinds.artifact, artifact.id, {
      ...artifact,
      object: "agent.session.artifact",
    } satisfies ArtifactRecord);
  complete(tx, config, { ...record, checkpoint }, "completed");
}
/**
 * The child turns a sealing root turn closes. A completed root publishes the children the
 * pending index holds (finished, awaiting this checkpoint). A failed or cancelled root
 * closes every subagent turn still `in_progress` or `waiting`; those are read by status
 * rather than by scanning every turn the session ever ran.
 */
function openChildTurns(tx: SessionTx, status: "completed" | "cancelled" | "failed"): Turn[] {
  const open: Turn[] = [];
  if (status === "completed") {
    open.push(...eachRecord(tx.store, SessionKinds.pendingSubagentTurn));
    return open;
  }
  for (const value of ["in_progress", "waiting"] as const)
    for (const turn of eachRecord(tx.store, SessionKinds.turn, { field: "status", value }))
      if (turn.subagent_id) open.push(turn);
  return open;
}
function closeChildTurns(
  tx: SessionTx,
  record: Fenced<ActiveSession>,
  status: "completed" | "cancelled" | "failed",
  turnError: SessionTurnError | null,
): void {
  for (const pending of openChildTurns(tx, status)) {
    const child: Turn =
      status === "completed"
        ? pending
        : {
            ...pending,
            status,
            completed_at: Math.floor(Date.now() / 1000),
            error: turnError,
          };
    tx.putTurn(child);
    finishOutputItems(tx, record, child.id, SessionKinds.subagentItem(child.subagent_id ?? ""));
    tx.emit({
      type: `agent.session.turn.${status}`,
      event_id: identifier("evt"),
      session_id: record.session.id,
      turn_id: child.id,
      turn: child,
      usage: child.usage,
    });
  }
  tx.store.clear(SessionKinds.pendingSubagentTurn);
}
/** Seal the turn, together with the checkpoint and event log, in one transaction. */
export function complete(
  tx: SessionTx,
  config: TurnConfig,
  record: Fenced<ActiveSession>,
  status: "completed" | "cancelled" | "failed",
  error?: string,
): void {
  const turnError: SessionTurnError | null = error
    ? {
        code: KNOWN_TURN_ERRORS.has(error) ? (error as TurnErrorCode) : "internal_error",
        message: error,
      }
    : null;
  const indeterminate = status === "failed" && isIndeterminate(error);
  closeChildTurns(tx, record, status, turnError);
  const turn: Turn = {
    ...tx.requireTurn(record.execution.turnId),
    status,
    completed_at: Math.floor(Date.now() / 1000),
    error: turnError,
  };
  tx.putTurn(turn);
  finishOutputItems(tx, record, turn.id, SessionKinds.item);
  tx.store.clear(SessionKinds.command);
  tx.store.clear(SessionKinds.cancellation);
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
  tx.save(next);
  tx.emit({
    type: `agent.session.turn.${status}`,
    event_id: identifier("evt"),
    session_id: record.session.id,
    turn_id: turn.id,
    turn,
    usage: turn.usage,
  });
  tx.emit({
    type: indeterminate ? "agent.session.failed" : "agent.session.idle",
    event_id: identifier("evt"),
    session: next.session,
  });
  // Steer input the runtime refused was never processed: run it now. Cancellation
  // supersedes it, and an indeterminate session accepts no further input.
  const queued = tx.store.list(SessionKinds.queuedInput, { order: "asc", limit: 100 }).data;
  tx.store.clear(SessionKinds.queuedInput);
  if (!queued.length || status === "cancelled" || indeterminate) return;
  const input = queued.flatMap((entry) => entry.input);
  const started = begin(tx, config, next, input);
  addInput(tx, started, input);
  tx.save(started);
}

// --- Input ----------------------------------------------------------------------------

function acceptMessage(
  tx: SessionTx,
  config: TurnConfig,
  driver: RuntimeDriver,
  record: SessionRecord,
  input: InputMessage[],
): SessionRecord {
  if (
    !driver.capabilities.images &&
    input.some((message) => message.content.some((part) => part.type === "input_image"))
  )
    throw new CapabilityUnsupported({ capability: "image_input", harness: driver.name });
  if (record.execution) {
    if (!driver.capabilities.steer) throw new SteeringUnsupported({ harness: driver.name });
    const itemIds = addInput(tx, record, input);
    enqueue(tx, record, { type: "steer", input }, itemIds);
    return record;
  }
  const started = begin(tx, config, record, input);
  addInput(tx, started, input);
  return started;
}
function acceptToolResult(
  tx: SessionTx,
  driver: RuntimeDriver,
  record: SessionRecord,
  event: Extract<InputEvent, { type: "agent.session.input.tool_result" }>,
): SessionRecord {
  if (
    !driver.capabilities.images &&
    Array.isArray(event.output) &&
    event.output.some((part) => part.type === "input_image")
  )
    throw new CapabilityUnsupported({ capability: "image_function_results", harness: driver.name });
  const action = record.session.required_actions.find(
    (candidate) =>
      candidate.type === "function_call" &&
      candidate.call_id === event.call_id &&
      candidate.turn_id === event.turn_id,
  );
  if (!action || !record.execution) throw new UnknownToolCall({ callId: event.call_id });
  recordToolResult(tx, record, event);
  enqueue(tx, record, {
    type: "tool_result",
    callId: event.call_id,
    success: event.success,
    output: event.success ? (event.output ?? "") : (event.error ?? "Tool failed"),
  });
  const required_actions = record.session.required_actions.filter((value) => value !== action);
  const next: SessionRecord = {
    ...record,
    session: {
      ...record.session,
      required_actions,
      status: required_actions.length ? "requires_action" : "in_progress",
    },
  };
  if (!required_actions.length) {
    const turn = tx.requireTurn(event.turn_id);
    tx.putTurn({ ...turn, status: "in_progress" });
    tx.emit({
      type: "agent.session.in_progress",
      event_id: identifier("evt"),
      session: next.session,
    });
  }
  return next;
}
/**
 * Accept submitted input under its idempotency key: start a turn, steer the active one,
 * queue a cancellation or answer a required action. Runs in one transaction.
 */
export function acceptInput(
  tx: SessionTx,
  config: TurnConfig,
  driver: (record: SessionRecord) => RuntimeDriver,
  events: InputEvent[],
  key: string,
): void {
  let record = tx.requireSession();
  const fingerprint = canonicalJSON(events);
  const previous = tx.store.get(SessionKinds.idempotency, key);
  if (previous) {
    if (previous !== fingerprint) throw new IdempotencyConflict({ subject: "input" });
    return;
  }
  if (record.phase === "failed") throw new SessionFailed();
  if (record.phase === "checkpointing") throw new TurnCheckpointing();
  const resolved = driver(record);
  const images = new Set<string>();
  for (const event of events) {
    if (event.type === "agent.session.input.message")
      remoteImageURLs(
        event.input.flatMap((message) => message.content),
        images,
      );
    else if (event.type === "agent.session.input.tool_result" && Array.isArray(event.output))
      remoteImageURLs(event.output, images);
  }
  assertImageLimit(images);
  for (const event of events) {
    switch (event.type) {
      case "agent.session.input.message":
        record = acceptMessage(tx, config, resolved, record, event.input);
        break;
      case "agent.session.input.cancel":
        if (record.execution) enqueue(tx, record, { type: "cancel" });
        break;
      case "agent.session.input.tool_result":
        record = acceptToolResult(tx, resolved, record, event);
        break;
    }
  }
  tx.store.put(SessionKinds.idempotency, key, fingerprint);
  // Accepted input counts as activity even when it only queues a command.
  record = {
    ...record,
    session: { ...record.session, last_active_at: Math.floor(Date.now() / 1_000) },
  };
  tx.save(record);
}

// --- Environment ----------------------------------------------------------------------

/** Publish an environment status once, in order; a failed setup fails an idle session. */
export function applyEnvironmentStatus(
  tx: SessionTx,
  status: AgentSessionEnvironmentState["status"],
): void {
  const record = tx.requireSession();
  if (record.session.environment.type === "none") return;
  const current = tx.store.get(SessionKinds.environment, "status");
  if (current === status) return;
  // A creation retry reports pending again; a settled environment never regresses.
  if (status === "pending" && current !== undefined) return;
  // Only a connected sandbox can disconnect, and a failed setup never reconnects.
  if (status === "disconnected" && current !== "connected") return;
  if (status === "connected" && current === "failed") return;
  tx.store.put(SessionKinds.environment, "status", status);
  tx.emit({
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
    tx.save(next);
    tx.emit({
      type: "agent.session.failed",
      event_id: identifier("evt"),
      session: next.session,
    });
  }
}

// --- Deletion -------------------------------------------------------------------------

export interface Deleted {
  id: string;
  object: "agent.session.deleted";
  deleted: true;
}
/** Mark the session deleted; a purged object answers from its tombstone so a retry succeeds. */
export function markDeleted(tx: SessionTx): Deleted {
  const stored = tx.store.get(SessionKinds.state, "session");
  if (!stored) {
    const tombstone = tx.store.get(SessionKinds.tombstone, "tombstone");
    if (!tombstone) throw new SessionNotFound();
    return deleted(tombstone.id, "agent.session.deleted");
  }
  const record = migrate(stored);
  if (record.execution) throw new TurnActive({ action: "delete" });
  tx.save({ ...record, deleted: true });
  return deleted(record.session.id, "agent.session.deleted");
}
/** Drop every record once the catalog no longer discovers the session. Idempotent. */
export function purgeRecords(tx: SessionTx): boolean {
  const record = tx.store.get(SessionKinds.state, "session");
  if (record && !record.deleted) throw new SessionNotDeleted();
  const id = record?.session.id ?? tx.store.get(SessionKinds.tombstone, "tombstone")?.id;
  if (!id) return false;
  tx.store.purge();
  tx.store.put(SessionKinds.tombstone, "tombstone", { id });
  return true;
}
