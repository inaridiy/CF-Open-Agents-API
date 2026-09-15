import { SessionNotFound, Superseded } from "../errors.js";
import type { AgentSessionEvent, Turn } from "../protocol.js";
import type { Execution } from "../runtime.js";
import type { RecordStore } from "./record-store.js";
import { SessionKinds } from "./session-kinds.js";
import {
  type ActiveSession,
  type Command,
  migrate,
  type SessionRecord,
  validate,
} from "./session-record.js";

/**
 * Typed, synchronous view of one session's rows. Every method is plain and total: it
 * either returns or throws a tagged domain error, and a throw inside a transaction is
 * the rollback. Nothing here suspends, so a callback over it can run in `transactionSync`.
 */
export interface SessionTx {
  /** Escape hatch for kinds without a dedicated accessor (items, outputs, subagents). */
  readonly store: RecordStore;
  /** The record after migration and validation; a migrated record is written back. */
  session(): SessionRecord | undefined;
  /** Throws `SessionNotFound` for a missing or deleted session, `InvalidSessionState` for a corrupt one. */
  requireSession(): SessionRecord;
  /** Validates the phase/execution invariant before writing. */
  save(record: SessionRecord): void;
  emit(event: AgentSessionEvent): void;
  turn(id: string): Turn | undefined;
  /** Throws the 404 `ApiError` the public turn endpoints answer with. */
  requireTurn(id: string): Turn;
  putTurn(turn: Turn): void;
  /** Queued deliveries in acceptance order, at most `limit`. */
  commands(limit: number): Command[];
  cancellation(turnId: string): Command | undefined;
  /** Throws `Superseded` when `(generation, turnId)` no longer match the durable record. */
  fenced(execution: Execution): ActiveSession;
}

export const makeSessionTx = (store: RecordStore): SessionTx => {
  const session = (): SessionRecord | undefined => {
    const original = store.get(SessionKinds.state, "session");
    if (!original) return undefined;
    const record = migrate(original);
    validate(record);
    if (record !== original) store.put(SessionKinds.state, "session", record);
    return record;
  };
  return {
    store,
    session,
    requireSession: () => {
      const record = session();
      if (!record || record.deleted) throw new SessionNotFound();
      return record;
    },
    save: (record) => {
      validate(record);
      store.put(SessionKinds.state, "session", record);
    },
    emit: (event) => {
      store.append(event);
    },
    turn: (id) => store.get(SessionKinds.turn, id),
    requireTurn: (id) => store.require(SessionKinds.turn, id),
    putTurn: (turn) => store.put(SessionKinds.turn, turn.id, turn),
    commands: (limit) => store.list(SessionKinds.command, { order: "asc", limit }).data,
    cancellation: (turnId) => store.get(SessionKinds.cancellation, turnId),
    fenced: (execution) => {
      const record = session();
      if (
        !record ||
        record.deleted ||
        record.execution?.generation !== execution.generation ||
        record.execution.turnId !== execution.turnId
      )
        throw new Superseded({ turnId: execution.turnId, generation: execution.generation });
      return record as ActiveSession;
    },
  };
};
