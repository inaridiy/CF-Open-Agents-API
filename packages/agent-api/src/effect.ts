import { Cause, Data, Effect, Exit, Schema } from "effect";

import { ApiError, remoteApiError } from "./protocol.js";

/** An I/O failure has an operation and a cause; it is never permission to replay a write. */
export class OperationError extends Data.TaggedError("OperationError")<{
  readonly operation: string;
  readonly cause: unknown;
}> {
  override get message(): string {
    return `${this.operation} failed`;
  }
}

export type ServiceError = ApiError | OperationError;
const failure = (operation: string, cause: unknown): ServiceError =>
  (cause instanceof Error && remoteApiError(cause)) || new OperationError({ operation, cause });

/** SDK / platform Promise boundary. Propagate interruption to APIs accepting a signal. */
export const io = <A>(operation: string, f: (signal: AbortSignal) => PromiseLike<A>) =>
  Effect.tryPromise({ try: f, catch: (cause) => failure(operation, cause) });

/** Synchronous SQLite/validation boundary; the callback cannot suspend. */
export const attempt = <A>(operation: string, f: () => A) =>
  Effect.try({ try: f, catch: (cause) => failure(operation, cause) });

/** Preserve API errors across Workers RPC instead of exporting FiberFailure wrappers. */
export async function runPromise<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) return exit.value;
  throw Cause.squash(exit.cause);
}

export function runSync<A, E>(effect: Effect.Effect<A, E>): A {
  const exit = Effect.runSyncExit(effect);
  if (Exit.isSuccess(exit)) return exit.value;
  throw Cause.squash(exit.cause);
}

/** Strict decoding at untrusted HTTP, RPC and persistence boundaries. */
export const decodeEffect = <A, I>(schema: Schema.Schema<A, I>, input: unknown) =>
  Schema.decodeUnknown(schema, { onExcessProperty: "error" })(input).pipe(
    Effect.mapError((error) => new ApiError(400, "invalid_request", error.message)),
  );
export const decode = <A, I>(schema: Schema.Schema<A, I>, input: unknown): A =>
  runSync(decodeEffect(schema, input));
