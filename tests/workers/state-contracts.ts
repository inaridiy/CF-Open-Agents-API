import { Effect } from "effect";

import type { SessionRepo } from "../../packages/agent-api/src/persistence/session-repo.js";
import type { SessionRecord } from "../../packages/agent-api/src/session.js";
import type { SqlStore } from "../../packages/agent-api/src/storage.js";

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
