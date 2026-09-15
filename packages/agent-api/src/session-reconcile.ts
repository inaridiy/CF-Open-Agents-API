import { Clock, Effect, Option } from "effect";

import { type StorageFailure, toApiError, type TransportFailure } from "./errors.js";
import { SessionKinds } from "./persistence/session-kinds.js";
import type { ActiveSession, Command } from "./persistence/session-record.js";
import type { SessionRepo, Sync } from "./persistence/session-repo.js";
import type { SessionTx } from "./persistence/session-tx.js";
import type { Execution, RuntimeDriver } from "./runtime.js";
import { Alarm, Drivers, Repo } from "./session-services.js";
import {
  acceptBatch,
  commitCheckpoint,
  complete,
  markRunning,
  reject,
  type TurnConfig,
} from "./session-state.js";

/**
 * The reconciler: one alarm tick drives the active turn forward against its runtime.
 * Every durable write is fenced on the execution identity through `tx.fenced`, so a
 * turn that was superseded while the tick waited on I/O ends the tick silently. The
 * error policy is a type: a definite answer (a runtime rejection, a protocol violation,
 * an unstorable record) fails the turn with its code at once; a transport or storage
 * failure propagates, is logged by the alarm and retried by the next one.
 */
interface Tick {
  readonly repo: SessionRepo;
  readonly config: TurnConfig;
  readonly driver: RuntimeDriver;
  readonly execution: Execution;
}
/** Bound on how many command-and-poll rounds one alarm runs; the next alarm continues. */
const ROUNDS_PER_TICK = 16;

const fenced = <A>(tick: Tick, f: (record: ActiveSession, tx: SessionTx) => Sync<A>) =>
  tick.repo.transaction((tx) => f(tx.fenced(tick.execution), tx));
const finish = (tick: Tick, status: "cancelled" | "failed", error?: string) =>
  fenced(tick, (record, tx) => complete(tx, tick.config, record, status, error));
const stopAndFail = (tick: Tick, code: string) =>
  tick.driver
    .stop(tick.execution)
    .pipe(Effect.zipRight(finish(tick, "failed", code)), Effect.asVoid);
const expired = (execution: Execution) =>
  Clock.currentTimeMillis.pipe(Effect.map((now) => now >= execution.deadline));

/** Cancellation supersedes queued input; its operation id stays until the outcome is durable. */
const pendingCommands = Effect.fn("session.commands")(function* (tick: Tick) {
  const { cancellation, queued } = yield* tick.repo.read((tx) => ({
    cancellation: tx.cancellation(tick.execution.turnId),
    queued: tx.commands(100),
  }));
  // Also accept cancellation records written by the previous implementation.
  const legacy = queued.find((operation) => operation.command.type === "cancel");
  const cancel = cancellation ?? legacy;
  if (cancel && !cancellation)
    yield* fenced(tick, (_record, tx) =>
      tx.store.put(SessionKinds.cancellation, tick.execution.turnId, cancel),
    );
  return { cancel, commands: cancel ? [cancel] : queued };
});

/**
 * Deliver one command. A refused command is dropped (a steer's input is queued for the
 * next turn); an unknown delivery outcome is retried after polling, so a turn the
 * runtime already finished can still be sealed. A cancellation's delivery outcome never
 * matters: the native outcome is reconciled.
 */
const deliver = Effect.fn("session.deliver")(function* (
  tick: Tick,
  operation: Command,
  cancel: Command | undefined,
) {
  const remove = fenced(tick, (_record, tx) => tx.store.remove(SessionKinds.command, operation.id));
  if (operation.turnId !== tick.execution.turnId) {
    if (!cancel) yield* remove;
    return "skipped" as const;
  }
  const refused = (error: unknown) =>
    cancel
      ? Effect.logWarning("Cancellation delivery failed; reconciling native outcome", error).pipe(
          Effect.as("skipped" as const),
        )
      : Effect.logWarning("Executor refused a queued command", error).pipe(
          Effect.zipRight(fenced(tick, (_record, tx) => reject(tx, operation))),
          Effect.as("skipped" as const),
        );
  const delivery = yield* tick.driver.control(tick.execution, operation.id, operation.command).pipe(
    Effect.as("delivered" as const),
    Effect.catchTags({
      CommandRejected: refused,
      ExecutionMissing: refused,
      TransportFailure: (error) =>
        cancel
          ? refused(error)
          : Effect.logWarning("Command delivery failed; polling first", error).pipe(
              Effect.as("retry" as const),
            ),
    }),
  );
  if (delivery === "delivered" && !cancel) yield* remove;
  return delivery;
});

/** Recover the checkpoint once completion is durable, even if compute vanished. */
const checkpoint = (tick: Tick) => {
  const seal = (code: string) => stopAndFail(tick, code);
  // A checkpoint is attempted even after the deadline: an already committed result can
  // still be recovered. Only a failure to answer is bounded by the deadline.
  const unavailable = (error: TransportFailure | StorageFailure) =>
    expired(tick.execution).pipe(
      Effect.flatMap((late) => (late ? seal("checkpoint_unavailable") : Effect.fail(error))),
    );
  return tick.driver.checkpoint(tick.execution).pipe(
    Effect.flatMap((result) =>
      fenced(tick, (record, tx) => commitCheckpoint(tx, tick.config, record, result)),
    ),
    Effect.catchTags({
      RuntimeRejected: (error) => seal(error.code),
      CheckpointIncompatible: (error) => seal(toApiError(error).code),
      RecordTooLarge: (error) => seal(toApiError(error).code),
      InvalidSessionState: (error) => seal(toApiError(error).code),
      ApiError: (error) => seal(error.code),
      TransportFailure: unavailable,
      StorageFailure: unavailable,
    }),
  );
};

/** One command-and-poll round; `again` when input accepted during the poll awaits delivery. */
const round = Effect.fn("session.round")(function* (tick: Tick) {
  yield* tick.repo.read((tx) => tx.fenced(tick.execution));
  if (yield* expired(tick.execution)) {
    yield* stopAndFail(tick, "request_timeout");
    return "done" as const;
  }
  const { cancel, commands } = yield* pendingCommands(tick);
  // Delivery never blocks the poll.
  let retryDelivery = false;
  for (const operation of commands) {
    yield* tick.repo.read((tx) => tx.fenced(tick.execution));
    if ((yield* deliver(tick, operation, cancel)) === "retry") {
      retryDelivery = true;
      break;
    }
  }
  const cursor = yield* tick.repo.read((tx) => tx.fenced(tick.execution).cursor);
  const batch = yield* tick.driver.poll(tick.execution, cursor);
  // A protocol violation rolls the whole batch back and fails the turn with its code.
  const phase = yield* fenced(tick, (record, tx) => acceptBatch(tx, record, batch, cancel));
  if (phase === "checkpointing") {
    yield* checkpoint(tick);
    return "done" as const;
  }
  if (batch.status === "failed" || batch.status === "missing") {
    yield* stopAndFail(
      tick,
      batch.status === "missing" ? "outcome_unknown" : (batch.error ?? "executor_failed"),
    );
    return "done" as const;
  }
  if (batch.status === "cancelled") {
    yield* tick.driver.stop(tick.execution);
    yield* finish(tick, "cancelled");
    return "done" as const;
  }
  return phase === "commands" && !retryDelivery ? ("again" as const) : ("done" as const);
});

const reconcileTurn = Effect.fn("session.turn")(function* (tick: Tick, initial: ActiveSession) {
  if (tick.driver.revision !== initial.revision) {
    yield* stopAndFail(tick, "executor_version_incompatible");
    return;
  }
  // Once completion is durable, recover the checkpoint directly, even if compute vanished.
  if (initial.phase === "checkpointing") {
    yield* checkpoint(tick);
    return;
  }
  if (yield* expired(tick.execution)) {
    yield* stopAndFail(tick, "request_timeout");
    return;
  }
  if (initial.phase === "starting") {
    yield* tick.driver.start(tick.execution, `${tick.execution.turnId}:start`);
    yield* fenced(tick, (record, tx) => markRunning(tx, record));
  }
  yield* round(tick).pipe(
    Effect.repeat({ while: (outcome) => outcome === "again", times: ROUNDS_PER_TICK }),
  );
});

/**
 * One reconciliation tick, run by the alarm under the object's permit. The platform
 * clears a fired alarm, so the tick re-arms before any I/O; a fence that no longer holds
 * ends the tick silently, because the winner owns the record.
 */
export const reconcileTick = Effect.fn("session.reconcile")(
  function* () {
    const repo = yield* Repo;
    const alarm = yield* Alarm;
    const drivers = yield* Drivers;
    const initial = yield* repo.read((tx) => tx.session());
    if (!initial?.execution || initial.deleted) return;
    const execution = initial.execution;
    yield* alarm.arm(drivers.pollIntervalMs);
    const config: TurnConfig = { maxTurnMs: drivers.maxTurnMs, agents: drivers.agents };
    const driver = Option.getOrUndefined(drivers.get(initial.driver));
    if (!driver) {
      // The deployment no longer registers this executor: nothing can poll or stop it,
      // and polling forever would only burn alarms.
      yield* repo.transaction((tx) =>
        complete(tx, config, tx.fenced(execution), "failed", "executor_unavailable"),
      );
      return;
    }
    const tick: Tick = { repo, config, driver, execution };
    yield* reconcileTurn(tick, initial).pipe(
      Effect.catchTags({
        RuntimeRejected: (error) => stopAndFail(tick, error.code),
        InvalidRuntimeEvent: (error) => stopAndFail(tick, error.code),
        RecordTooLarge: (error) => stopAndFail(tick, toApiError(error).code),
        InvalidSessionState: (error) => stopAndFail(tick, toApiError(error).code),
      }),
    );
  },
  Effect.catchTag("Superseded", () => Effect.void),
);
