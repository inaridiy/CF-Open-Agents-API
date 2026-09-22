import { Cause, Data, Effect, Exit, FiberId, Runtime, Schema } from "effect";

import { ApiError, remoteApiError } from "./api-error.js";
import { type DomainError, InvalidRequest, isDomainError } from "./errors.js";

/** An I/O failure has an operation and a cause; it is never permission to replay a write. */
export class OperationError extends Data.TaggedError("OperationError")<{
  readonly operation: string;
  readonly cause: unknown;
}> {
  override get message(): string {
    return `${this.operation} failed`;
  }
}

/**
 * What an Effect program may fail with: a tagged domain failure, an `OperationError`
 * from an I/O boundary, or an `ApiError` recovered from the wire name a definite
 * failure carried across an un-enveloped RPC hop.
 */
export type ServiceError = ApiError | OperationError | DomainError;
/** A typed failure keeps its tag; an RPC wire name becomes an ApiError; the rest is opaque. */
const failure = (operation: string, cause: unknown): ServiceError =>
  isDomainError(cause) || cause instanceof ApiError
    ? cause
    : (cause instanceof Error && remoteApiError(cause)) || new OperationError({ operation, cause });

/**
 * SDK / platform Promise boundary. The callback always receives the fiber's interruption
 * signal: `Effect.tryPromise` only creates one when the callback declares a parameter, so
 * it is declared here rather than left to each caller. Interrupting the fiber aborts an
 * API that consumes the signal and orphans one that cannot.
 *
 * Rule: a Promise whose outcome a later durable write depends on (a job dispatch after
 * its marker, an R2 put before its manifest, a commit after a consumed token) is wrapped
 * in `Effect.uninterruptible` at the call site, so an interrupt is delivered after the
 * outcome is known instead of turning a slow write into an unknown one.
 */
export const io = <A>(operation: string, f: (signal: AbortSignal) => PromiseLike<A>) =>
  Effect.tryPromise({ try: (signal) => f(signal), catch: (cause) => failure(operation, cause) });

/** Synchronous SQLite/validation boundary; the callback cannot suspend. */
export const attempt = <A>(operation: string, f: () => A) =>
  Effect.try({ try: f, catch: (cause) => failure(operation, cause) });

/** The messages down a failure's `cause` chain, for a log line an operator reads. */
export function causeChain(error: unknown): string[] {
  const chain: string[] = [];
  for (let current = error, depth = 0; current !== undefined && depth < 8; depth += 1) {
    chain.push(describe(current));
    current = current instanceof Error ? current.cause : undefined;
  }
  return chain;
}
function describe(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (typeof value !== "object" || value === null) return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable cause]";
  }
}

/** Every boundary runner settles the same way: the value, or the squashed cause thrown as itself. */
export function settle<A, E>(exit: Exit.Exit<A, E>): A {
  if (Exit.isSuccess(exit)) return exit.value;
  throw Cause.squash(exit.cause);
}
/** Preserve API errors across Workers RPC instead of exporting FiberFailure wrappers. */
export async function runPromise<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  // lint: entrypoint
  return settle(await Effect.runPromiseExit(effect));
}

/**
 * Boundary runner for provably synchronous effects. An effect that suspends would keep
 * running as a leaked fiber; it is stopped and reported as a defect of `operation`.
 */
export function runSync<A, E>(effect: Effect.Effect<A, E>, operation = "runSync"): A {
  // lint: entrypoint
  const exit = Effect.runSyncExit(effect);
  if (Exit.isSuccess(exit)) return exit.value;
  const error = Cause.squash(exit.cause);
  if (Runtime.isAsyncFiberException(error)) {
    error.fiber.unsafeInterruptAsFork(FiberId.none);
    throw new Error(`${operation} ran an asynchronous effect; use runPromise`, { cause: error });
  }
  throw error;
}

/** Strict decoding at untrusted HTTP, RPC and persistence boundaries. */
export const decodeEffect = <A, I>(schema: Schema.Schema<A, I>, input: unknown) =>
  Schema.decodeUnknown(schema, { onExcessProperty: "error" })(input).pipe(
    Effect.mapError((error) => new InvalidRequest({ issues: error.message })),
  );
export const decode = <A, I>(schema: Schema.Schema<A, I>, input: unknown): A =>
  // lint: entrypoint
  runSync(decodeEffect(schema, input), "decode");
