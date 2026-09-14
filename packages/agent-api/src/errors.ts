import { Data, Effect, Either, Match, Schema } from "effect";

import { ApiError, remoteApiError } from "./protocol.js";

/**
 * Typed domain failures. `ApiError` remains the HTTP projection; every class here maps
 * to one through `toApiError`. Classes whose values cross Durable Object RPC inside an
 * envelope are `Schema.TaggedError`, so they decode back into instances on the caller;
 * the rest are `Data.TaggedError` and stay inside one object.
 *
 * A definite failure reports `ApiError`'s wire name through `name`, so a caller behind
 * an un-enveloped RPC hop still recovers its status and code the way it does for
 * `ApiError` (the platform reads `name` and `message` as ordinary properties). Transport
 * and storage failures are deliberately not named that way: a caller must never mistake
 * them for a definite answer.
 */
type Status = ApiError["status"];
const STATUSES: readonly Status[] = [400, 401, 404, 409, 413, 422, 429, 500, 503];
export const isStatus = (value: unknown): value is Status => STATUSES.includes(value as Status);
const wireName = (error: DomainError): string => toApiError(error).name;

// --- Persistence ---------------------------------------------------------------------

export class RecordTooLarge extends Schema.TaggedError<RecordTooLarge>()("RecordTooLarge", {
  bytes: Schema.Number,
}) {
  override get name(): string {
    return wireName(this);
  }
  override get message(): string {
    return "Serialized record exceeds 1,900,000 bytes";
  }
}
export class InvalidCursor extends Schema.TaggedError<InvalidCursor>()("InvalidCursor", {}) {
  override get name(): string {
    return wireName(this);
  }
  override get message(): string {
    return "Cursor does not belong to this collection";
  }
}
/** Thrown inside a fenced transaction after an unexpected failure; never a definite answer. */
export class StorageFailure extends Data.TaggedError("StorageFailure")<{
  readonly operation: string;
  readonly cause: unknown;
}> {
  override get message(): string {
    return `${this.operation} failed`;
  }
}

// --- Session state --------------------------------------------------------------------

export class SessionNotFound extends Schema.TaggedError<SessionNotFound>()("SessionNotFound", {}) {
  override get name(): string {
    return wireName(this);
  }
  override get message(): string {
    return "Session not found";
  }
}
export class InvalidSessionState extends Schema.TaggedError<InvalidSessionState>()(
  "InvalidSessionState",
  { reason: Schema.String },
) {
  override get name(): string {
    return wireName(this);
  }
  override get message(): string {
    return this.reason;
  }
}
/** The durable execution identity moved on; the caller's work is void and stops silently. */
export class Superseded extends Data.TaggedError("Superseded")<{
  readonly turnId: string;
  readonly generation: number;
}> {
  override get name(): string {
    return wireName(this);
  }
  override get message(): string {
    return "Execution was superseded";
  }
}

// --- Input ----------------------------------------------------------------------------

export class IdempotencyConflict extends Schema.TaggedError<IdempotencyConflict>()(
  "IdempotencyConflict",
  { subject: Schema.String },
) {
  override get name(): string {
    return wireName(this);
  }
  override get message(): string {
    return `Key was used with different ${this.subject}`;
  }
}
export class SessionFailed extends Schema.TaggedError<SessionFailed>()("SessionFailed", {}) {
  override get name(): string {
    return wireName(this);
  }
  override get message(): string {
    return "Fork or create a new session after an indeterminate execution";
  }
}
export class TurnCheckpointing extends Schema.TaggedError<TurnCheckpointing>()(
  "TurnCheckpointing",
  {},
) {
  override get name(): string {
    return wireName(this);
  }
  override get message(): string {
    return "Wait for the current turn to become idle";
  }
}
export class UnknownToolCall extends Schema.TaggedError<UnknownToolCall>()("UnknownToolCall", {
  callId: Schema.String,
}) {
  override get name(): string {
    return wireName(this);
  }
  // The official SDK retries a tool result submitted before the call was registered only
  // when the response is a 400 whose `code` is `invalid_request_error` and whose message
  // is exactly this text (openai/lib/agents/agent-session-stream.js, `#submit`).
  override get message(): string {
    return `Unknown pending tool call: ${this.callId}`;
  }
}

// --- Runtime protocol -----------------------------------------------------------------

/** A runtime batch names state this session never created, or breaks the cursor sequence. */
export class InvalidRuntimeEvent extends Data.TaggedError("InvalidRuntimeEvent")<{
  readonly code: "invalid_runtime_event" | "invalid_runtime_cursor";
  readonly message: string;
}> {
  override get name(): string {
    return wireName(this);
  }
}
/** The runtime refused a command for good; it is dropped, never retried. */
export class CommandRejected extends Data.TaggedError("CommandRejected")<{
  readonly code: string;
  readonly message: string;
}> {
  override get name(): string {
    return wireName(this);
  }
}
/** No such job on the runtime; a command cannot apply. */
export class ExecutionMissing extends Data.TaggedError("ExecutionMissing")<{
  readonly message: string;
}> {
  override get name(): string {
    return wireName(this);
  }
}
/** The runtime answered start or checkpoint with a definite rejection; the turn fails with its code. */
export class RuntimeRejected extends Data.TaggedError("RuntimeRejected")<{
  readonly status: Status;
  readonly code: string;
  readonly message: string;
}> {
  override get name(): string {
    return wireName(this);
  }
}
export class CheckpointIncompatible extends Data.TaggedError("CheckpointIncompatible")<{
  readonly message: string;
}> {
  override get name(): string {
    return wireName(this);
  }
}
/** No answer, or an answer nobody can classify: the only retryable failure. */
export class TransportFailure extends Data.TaggedError("TransportFailure")<{
  readonly operation: string;
  readonly cause: unknown;
}> {
  override get message(): string {
    return `${this.operation} failed`;
  }
}

export type DomainError =
  | RecordTooLarge
  | InvalidCursor
  | StorageFailure
  | SessionNotFound
  | InvalidSessionState
  | Superseded
  | IdempotencyConflict
  | SessionFailed
  | TurnCheckpointing
  | UnknownToolCall
  | InvalidRuntimeEvent
  | CommandRejected
  | ExecutionMissing
  | RuntimeRejected
  | CheckpointIncompatible
  | TransportFailure;
const DOMAIN_CLASSES = [
  RecordTooLarge,
  InvalidCursor,
  StorageFailure,
  SessionNotFound,
  InvalidSessionState,
  Superseded,
  IdempotencyConflict,
  SessionFailed,
  TurnCheckpointing,
  UnknownToolCall,
  InvalidRuntimeEvent,
  CommandRejected,
  ExecutionMissing,
  RuntimeRejected,
  CheckpointIncompatible,
  TransportFailure,
] as const;
export const isDomainError = (value: unknown): value is DomainError =>
  DOMAIN_CLASSES.some((cls) => value instanceof cls);

/** The one HTTP/RPC projection: status, code and message for every domain failure. */
const project = Match.type<DomainError | ApiError>().pipe(
  Match.tag("ApiError", (error) => error),
  Match.tag(
    "RecordTooLarge",
    (error) => new ApiError(413, "storage_record_too_large", error.message),
  ),
  Match.tag("InvalidCursor", (error) => new ApiError(400, "invalid_cursor", error.message)),
  Match.tag("SessionNotFound", (error) => new ApiError(404, "not_found", error.message)),
  Match.tag(
    "InvalidSessionState",
    (error) => new ApiError(409, "invalid_session_state", error.message),
  ),
  Match.tag("Superseded", (error) => new ApiError(409, "stale_generation", error.message)),
  Match.tag(
    "IdempotencyConflict",
    (error) => new ApiError(409, "idempotency_conflict", error.message),
  ),
  Match.tag("SessionFailed", (error) => new ApiError(409, "session_failed", error.message)),
  Match.tag("TurnCheckpointing", (error) => new ApiError(409, "turn_checkpointing", error.message)),
  Match.tag(
    "UnknownToolCall",
    (error) => new ApiError(400, "invalid_request_error", error.message),
  ),
  Match.tag("InvalidRuntimeEvent", (error) => new ApiError(409, error.code, error.message)),
  Match.tag("CommandRejected", (error) => new ApiError(409, error.code, error.message)),
  Match.tag("ExecutionMissing", (error) => new ApiError(404, "execution_missing", error.message)),
  Match.tag("RuntimeRejected", (error) => new ApiError(error.status, error.code, error.message)),
  Match.tag(
    "CheckpointIncompatible",
    (error) => new ApiError(409, "invalid_checkpoint", error.message),
  ),
  Match.tag(
    "TransportFailure",
    "StorageFailure",
    () => new ApiError(500, "internal_error", "Internal server error"),
  ),
  Match.exhaustive,
);
export const toApiError = (error: DomainError | ApiError): ApiError => project(error);
/** Anything a boundary may catch: a domain failure, an `ApiError`, or its RPC wire name. */
export function projectApiError(error: unknown): ApiError | undefined {
  if (isDomainError(error) || error instanceof ApiError) return toApiError(error);
  return error instanceof Error ? remoteApiError(error) : undefined;
}
/** A thrown definite answer: an `ApiError`, its RPC wire name, or a plain `{ status, code }`. */
export function rejection(
  cause: unknown,
): { status: Status; code: string; message: string } | undefined {
  const known = projectApiError(cause);
  // A fresh record, never the caught instance: `Data` errors copy own fields, tag included.
  if (known) return { status: known.status, code: known.code, message: known.message };
  if (
    typeof cause === "object" &&
    cause !== null &&
    "status" in cause &&
    "code" in cause &&
    isStatus(cause.status) &&
    typeof cause.code === "string"
  )
    return {
      status: cause.status,
      code: cause.code,
      message: "message" in cause && typeof cause.message === "string" ? cause.message : cause.code,
    };
  return undefined;
}

// --- RPC envelope ---------------------------------------------------------------------

/** A plain `ApiError` inside an envelope: its tag, status and code travel as data. */
export const ApiErrorSchema = Schema.transform(
  Schema.Struct({
    _tag: Schema.Literal("ApiError"),
    status: Schema.Literal(...STATUSES),
    code: Schema.String,
    message: Schema.String,
  }),
  Schema.instanceOf(ApiError),
  {
    strict: true,
    decode: ({ status, code, message }) => new ApiError(status, code, message),
    encode: (error) => ({
      _tag: "ApiError" as const,
      status: error.status,
      code: error.code,
      message: error.message,
    }),
  },
);
/** Expected failures cross DO RPC as data, without platform error logs; the rest still throw. */
export const RpcFailure = Schema.Union(
  RecordTooLarge,
  InvalidCursor,
  SessionNotFound,
  InvalidSessionState,
  IdempotencyConflict,
  SessionFailed,
  TurnCheckpointing,
  UnknownToolCall,
  ApiErrorSchema,
);
export type RpcFailure = typeof RpcFailure.Type;
export const isRpcFailure: (value: unknown) => value is RpcFailure = Schema.is(RpcFailure);
export const rpcEnvelope = <A, I>(success: Schema.Schema<A, I>) =>
  Schema.Either({ left: RpcFailure, right: success });
/** Callee side: an expected failure becomes data; anything else still throws across RPC. */
export const encodeRpc = <A, I, E, R>(
  envelope: Schema.Schema<Either.Either<A, RpcFailure>, I>,
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.map((value): Either.Either<A, RpcFailure> => Either.right(value)),
    Effect.catchIf(
      (error: E): error is E & RpcFailure => isRpcFailure(error),
      (error): Effect.Effect<Either.Either<A, RpcFailure>> => Effect.succeed(Either.left(error)),
    ),
    Effect.map(Schema.encodeSync(envelope)),
  );
/** Caller side: the envelope decodes back into instances, so a failure re-enters the fiber tagged. */
export const decodeRpc =
  <A, I>(envelope: Schema.Schema<Either.Either<A, RpcFailure>, I>) =>
  (encoded: unknown): Effect.Effect<A, RpcFailure> =>
    Schema.decodeUnknown(envelope)(encoded).pipe(
      Effect.orDie,
      Effect.flatMap(Either.match({ onLeft: Effect.fail, onRight: Effect.succeed })),
    );
