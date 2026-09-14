import { Effect } from "effect";

import type { SessionRecord } from "../../packages/agent-api/src/session.js";
import type { SqlStore } from "../../packages/agent-api/src/storage.js";

/** Compile-time regressions for the synchronous persistence boundary and state machine. */
export function stateContracts(db: SqlStore, record: SessionRecord) {
  // @ts-expect-error A suspended callback cannot participate in transactionSync.
  void db.transaction(async () => 1);
  // @ts-expect-error Constructing an Effect is not executing a synchronous transaction.
  const suspended = db.transaction(() => Effect.succeed(1));
  // @ts-expect-error A running state must own a concrete execution.
  const impossible: SessionRecord = { ...record, phase: "running", execution: null };
  return [impossible, suspended] as const;
}
