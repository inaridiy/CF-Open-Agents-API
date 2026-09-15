import { Effect } from "effect";

import {
  CheckpointIncompatible,
  IdempotencyConflict,
  InvalidCursor,
  InvalidRuntimeEvent,
  InvalidSessionState,
  RecordTooLarge,
  SessionFailed,
  SessionNotFound,
  StorageFailure,
  Superseded,
  TurnCheckpointing,
  UnknownToolCall,
} from "../errors.js";
import { ApiError } from "../protocol.js";
import type { RecordStore, Transactional } from "./record-store.js";
import { makeSessionTx, type SessionTx } from "./session-tx.js";

/**
 * Everything a session transaction may throw on purpose. `ApiError` is the HTTP
 * projection input validation raises inside `submit`; it stays a typed failure until the
 * RPC envelope. Anything else thrown inside the seam is a `StorageFailure`: an unknown
 * outcome, never a definite answer.
 */
export type SessionTxError =
  | RecordTooLarge
  | InvalidCursor
  | SessionNotFound
  | InvalidSessionState
  | Superseded
  | IdempotencyConflict
  | SessionFailed
  | TurnCheckpointing
  | UnknownToolCall
  | InvalidRuntimeEvent
  | CheckpointIncompatible
  | ApiError;
const TX_ERRORS = [
  RecordTooLarge,
  InvalidCursor,
  SessionNotFound,
  InvalidSessionState,
  Superseded,
  IdempotencyConflict,
  SessionFailed,
  TurnCheckpointing,
  UnknownToolCall,
  InvalidRuntimeEvent,
  CheckpointIncompatible,
  ApiError,
] as const;
export const isSessionTxError = (value: unknown): value is SessionTxError =>
  TX_ERRORS.some((cls) => value instanceof cls);

/** A synchronous result: returning a Promise or an Effect from the seam is a type error. */
export type Sync<A> = A &
  (A extends PromiseLike<unknown> | Effect.Effect<unknown, unknown, unknown> ? never : unknown);

/**
 * The outside edge of the seam. `transaction` runs `f` in one `transactionSync`: a throw
 * rolls the transaction back and then becomes the failure channel, classified. `read`
 * runs `f` against the same view without a transaction. Both are lazy: constructing the
 * effect runs nothing, and the callback runs on the fiber's current tick.
 */
export interface SessionRepo {
  readonly transaction: <A>(
    f: (tx: SessionTx) => Sync<A>,
  ) => Effect.Effect<A, SessionTxError | StorageFailure>;
  readonly read: <A>(
    f: (tx: SessionTx) => Sync<A>,
  ) => Effect.Effect<A, SessionTxError | StorageFailure>;
}

export const makeSessionRepo = (store: RecordStore, transactional: Transactional): SessionRepo => {
  const tx = makeSessionTx(store);
  const attempt = <A>(operation: string, run: () => A) =>
    Effect.suspend((): Effect.Effect<A, SessionTxError | StorageFailure> => {
      try {
        return Effect.succeed(run());
      } catch (thrown) {
        return Effect.fail(
          isSessionTxError(thrown) ? thrown : new StorageFailure({ operation, cause: thrown }),
        );
      }
    });
  return {
    transaction: (f) =>
      attempt("session.transaction", () => transactional.transactionSync(() => f(tx))),
    read: (f) => attempt("session.read", () => f(tx)),
  };
};
