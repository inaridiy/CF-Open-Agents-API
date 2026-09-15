import {
  CapabilityUnsupported,
  CheckpointIncompatible,
  ExecutorVersionIncompatible,
  IdempotencyConflict,
  ImageLimitExceeded,
  InvalidCursor,
  InvalidRuntimeEvent,
  InvalidSessionState,
  RecordNotFound,
  RecordTooLarge,
  SessionFailed,
  SessionNotDeleted,
  SessionNotFound,
  SteeringUnsupported,
  Superseded,
  TurnActive,
  TurnCheckpointing,
  UnknownToolCall,
} from "../errors.js";
import type { RecordStore, Transactional } from "./record-store.js";
import { makeRepo, type Repo } from "./repo.js";
import { makeSessionTx, type SessionTx } from "./session-tx.js";

export type { Sync } from "./repo.js";

/**
 * Everything a session transaction may throw on purpose: the persistence failures of
 * the store and the state machine's own rules. Each stays a typed failure until the RPC
 * envelope. Anything else thrown inside the seam is a `StorageFailure`: an unknown
 * outcome, never a definite answer.
 */
const TX_ERRORS = [
  RecordTooLarge,
  RecordNotFound,
  InvalidCursor,
  SessionNotFound,
  InvalidSessionState,
  Superseded,
  IdempotencyConflict,
  SessionFailed,
  TurnCheckpointing,
  TurnActive,
  SessionNotDeleted,
  SteeringUnsupported,
  UnknownToolCall,
  ExecutorVersionIncompatible,
  CapabilityUnsupported,
  ImageLimitExceeded,
  InvalidRuntimeEvent,
  CheckpointIncompatible,
] as const;
export type SessionTxError = InstanceType<(typeof TX_ERRORS)[number]>;
export const isSessionTxError = (value: unknown): value is SessionTxError =>
  TX_ERRORS.some((cls) => value instanceof cls);

/** The outside edge of the seam for a session: see `Repo`. */
export type SessionRepo = Repo<SessionTx, SessionTxError>;

export const makeSessionRepo = (store: RecordStore, transactional: Transactional): SessionRepo =>
  makeRepo(makeSessionTx(store), transactional, isSessionTxError, "session");
