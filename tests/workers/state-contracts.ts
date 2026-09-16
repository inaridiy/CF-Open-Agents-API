import { Effect } from "effect";

import type {
  ActiveSession,
  Command,
  Fenced,
} from "../../packages/agent-api/src/persistence/session-record.js";
import type { SessionRepo } from "../../packages/agent-api/src/persistence/session-repo.js";
import type { Checkpoint, RuntimeBatch } from "../../packages/agent-api/src/runtime.js";
import type { AgentBindings } from "../../packages/agent-api/src/service.js";
import {
  acceptBatch,
  commitCheckpoint,
  complete,
  markRunning,
  reject,
  type TurnConfig,
} from "../../packages/agent-api/src/session-state.js";
import type { SessionRecord } from "../../packages/agent-api/src/session.js";
import type { SqlStore } from "../../packages/agent-api/src/storage.js";
import { defineAgentWorker } from "../../packages/agent-api/src/worker.js";

/** Compile-time regressions for the synchronous persistence boundary and state machine. */
export function stateContracts(db: SqlStore, repo: SessionRepo, record: SessionRecord) {
  // @ts-expect-error A suspended callback cannot participate in transactionSync.
  void db.transaction(async () => 1);
  // @ts-expect-error Constructing an Effect is not executing a synchronous transaction.
  const suspended = db.transaction(() => Effect.succeed(1));
  // @ts-expect-error The repository seam rejects a Promise the same way.
  void repo.transaction(async () => 1);
  // @ts-expect-error An Effect cannot run inside the seam; yield it outside instead.
  const nested = repo.transaction(() => Effect.succeed(1));
  // @ts-expect-error A read is synchronous too.
  const asyncRead = repo.read(async (tx) => tx.session());
  // @ts-expect-error A running state must own a concrete execution.
  const impossible: SessionRecord = { ...record, phase: "running", execution: null };
  return [impossible, suspended, nested, asyncRead] as const;
}

/**
 * The transitions that overwrite an active record after the reconciler awaited the
 * runtime take the record as `tx.fenced` re-read it. An `ActiveSession` obtained any
 * other way (a read before the I/O, a spread of one, a literal) does not compile, and
 * the brand cannot be written by hand: only `SessionTx.fenced` certifies a record.
 */
export function fenceContracts(
  repo: SessionRepo,
  config: TurnConfig,
  active: ActiveSession,
  batch: RuntimeBatch,
  checkpoint: Checkpoint,
) {
  const stale = { ...active };
  const cancel: Command = {
    id: "op",
    turnId: active.execution.turnId,
    command: { type: "cancel" },
  };
  return [
    // @ts-expect-error A batch applies only to the record the writing transaction fenced.
    repo.transaction((tx) => acceptBatch(tx, active, batch, tx.cancellation(cancel.turnId))),
    // @ts-expect-error A spread of an unfenced record is still unfenced.
    repo.transaction((tx) => acceptBatch(tx, stale, batch, tx.cancellation(cancel.turnId))),
    // @ts-expect-error Sealing a turn needs the fence: a stale read must fail with Superseded, not win.
    repo.transaction((tx) => complete(tx, config, active, "completed")),
    // @ts-expect-error So does acknowledging the start.
    repo.transaction((tx) => markRunning(tx, active)),
    // @ts-expect-error And committing the checkpoint.
    repo.transaction((tx) => commitCheckpoint(tx, config, active, checkpoint)),
    // @ts-expect-error And refusing a queued command.
    repo.transaction((tx) => reject(tx, active, cancel)),
    // @ts-expect-error The brand is a private symbol: a hand-written one is not it.
    repo.transaction((tx) => markRunning(tx, { ...active, [Symbol("FencedBrand")]: true })),
    // The fenced record, and any record derived from it by spread, is accepted.
    repo.transaction((tx) => {
      const fenced: Fenced<ActiveSession> = tx.fenced(active.execution);
      markRunning(tx, { ...fenced, cursor: fenced.cursor });
      return acceptBatch(tx, fenced, batch, tx.cancellation(cancel.turnId));
    }),
  ] as const;
}

/** Without Container bindings the composition must name its drivers. */
export function compositionContracts() {
  // @ts-expect-error harnesses is required when Env lacks the Container bindings.
  return defineAgentWorker<AgentBindings & { API_TOKEN: string }>({
    agents: {},
    models: () => ({}),
    authenticate: async () => null,
  });
}
