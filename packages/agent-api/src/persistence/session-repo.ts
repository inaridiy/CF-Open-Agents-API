import {
  CheckpointIncompatible,
  IdempotencyConflict,
  InvalidCursor,
  InvalidRuntimeEvent,
  InvalidSessionState,
  RecordTooLarge,
  SessionFailed,
  SessionNotFound,
  Superseded,
  TurnCheckpointing,
  UnknownToolCall,
} from "../errors.js";
import { ApiError } from "../protocol.js";
import type { RecordStore, Transactional } from "./record-store.js";
import { makeRepo, type Repo } from "./repo.js";
import { makeSessionTx, type SessionTx } from "./session-tx.js";

export type { Sync } from "./repo.js";

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

/** The outside edge of the seam for a session: see `Repo`. */
export type SessionRepo = Repo<SessionTx, SessionTxError>;

export const makeSessionRepo = (store: RecordStore, transactional: Transactional): SessionRepo =>
  makeRepo(makeSessionTx(store), transactional, isSessionTxError, "session");
