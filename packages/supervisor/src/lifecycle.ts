import {
  canonicalJSON,
  OperationError,
  type RuntimeBatch,
  type RuntimeEvent,
  type TurnErrorCode,
} from "cf-open-agents-api";
import {
  Cause,
  Chunk,
  Data,
  Deferred,
  Duration,
  Effect,
  FiberId,
  MutableRef,
  Option,
  Predicate,
  Ref,
  SynchronizedRef,
} from "effect";

/**
 * Native failure detail for diagnostics; the public batch error stays a stable code.
 * A wrapper that names its step (`OperationError`, `NativeStartupFailed`) is followed
 * into its `cause`, so the line carries both.
 */
export function describeFailure(value: unknown): string {
  const squashed = Cause.isCause(value) ? Cause.squash(value) : value;
  if (
    squashed instanceof Error &&
    Predicate.hasProperty(squashed, "cause") &&
    squashed.cause !== undefined &&
    squashed.cause !== squashed
  )
    return `${squashed.message}: ${describeFailure(squashed.cause)}`;
  return squashed instanceof Error ? (squashed.stack ?? squashed.message) : String(squashed);
}

/**
 * Every failure the supervisor yields is a `Data.TaggedError`; a raw throw from a
 * native SDK or a Node API is not. The HTTP adapter maps tags to statuses; nothing
 * below it knows a status.
 */
export interface TaggedFailure extends Error {
  readonly _tag: string;
}
export const isTaggedFailure = (cause: unknown): cause is TaggedFailure =>
  cause instanceof Error && Predicate.hasProperty(cause, "_tag") && Predicate.isString(cause._tag);
/** A tagged failure reports itself; a raw throw is transient I/O of `operation`. */
export const asFailure =
  (operation: string) =>
  (cause: unknown): TaggedFailure =>
    isTaggedFailure(cause) ? cause : new OperationError({ operation, cause });

/** The event cursor does not address the retained log. */
export class InvalidCursor extends Data.TaggedError("InvalidCursor")<{}> {
  override get message(): string {
    return "Invalid event cursor";
  }
}
/** The job was stopped; pending calls and late starts are refused. */
export class ExecutionStopped extends Data.TaggedError("ExecutionStopped")<{}> {
  override get message(): string {
    return "Execution stopped";
  }
}
/** The turn was cancelled while a call was outstanding. */
export class ExecutionCancelled extends Data.TaggedError("ExecutionCancelled")<{}> {
  override get message(): string {
    return "Execution cancelled";
  }
}
/** A checkpoint was requested before the native turn completed. */
export class CheckpointUnavailable extends Data.TaggedError("CheckpointUnavailable")<{
  readonly reason: string;
}> {
  override get message(): string {
    return this.reason;
  }
}
/**
 * A definite verdict: the command can never apply to this execution (the turn ended,
 * the call is unknown, the harness cannot steer). The HarnessDO drops the command
 * instead of retrying it.
 */
export class CommandRejected extends Data.TaggedError("CommandRejected")<{
  readonly reason: string;
}> {
  override get message(): string {
    return this.reason;
  }
}
/** No job for that turn is owned here. */
export class ExecutionMissing extends Data.TaggedError("ExecutionMissing")<{}> {
  override get message(): string {
    return "Execution is missing";
  }
}
/** An operation or execution ID was reused with different input; the first outcome stands. */
export class IdempotencyConflict extends Data.TaggedError("IdempotencyConflict")<{
  readonly reason: string;
}> {
  override get message(): string {
    return this.reason;
  }
}

// --- Ownership verdicts of the single job slot -----------------------------------------

/** A start named a generation the slot has already moved past. */
export class ExecutionSuperseded extends Data.TaggedError("ExecutionSuperseded")<{}> {
  override get message(): string {
    return "Execution was superseded";
  }
}
/** A start named another session while this supervisor still belongs to one. */
export class AssignmentConflict extends Data.TaggedError("AssignmentConflict")<{}> {
  override get message(): string {
    return "Supervisor belongs to another session";
  }
}
/** A start arrived while the owned execution is still running. */
export class ExecutionActive extends Data.TaggedError("ExecutionActive")<{}> {
  override get message(): string {
    return "An execution is still active";
  }
}
/** A start repeated a turn whose job already failed; it cannot be replayed. */
export class ExecutionAlreadyFailed extends Data.TaggedError("ExecutionAlreadyFailed")<{}> {
  override get message(): string {
    return "Execution failed; it cannot be replayed";
  }
}
/** The execution names a harness this supervisor does not run. */
export class UnsupportedHarness extends Data.TaggedError("UnsupportedHarness")<{
  readonly harness: string;
}> {
  override get message(): string {
    return "Unsupported harness";
  }
}

type Outcome =
  | { readonly status: "running" | "waiting" }
  | { readonly status: "completed" | "cancelled" }
  | { readonly status: "failed"; readonly error: string };
interface JobState {
  readonly outcome: Outcome;
  /** Cancellation was requested: completion can no longer seal the job, events still flow. */
  readonly cancelling: boolean;
  /** The log is sealed: no further events or transitions. */
  readonly closing: boolean;
  readonly events: Chunk.Chunk<RuntimeBatch["events"][number]>;
  readonly bytes: number;
}
/** The three statuses a job never transitions out of; `running` and `waiting` are the rest. */
export const terminal = (status: string): boolean =>
  status === "completed" || status === "cancelled" || status === "failed";
const settled = (outcome: Outcome) => terminal(outcome.status);
/**
 * Public turn error codes of the OpenAI Agents API (`SessionTurnError.code` in
 * openai@7.15.0). A job fails with one of these; other strings reach the client as
 * `internal_error` with the string as the message. The Worker decides the same way
 * on its side of the wire, so the list is defined once, there.
 */
export { TURN_ERROR_CODES, type TurnErrorCode } from "cf-open-agents-api";

/**
 * The public code for a provider HTTP status, or undefined when the status itself
 * says nothing and the caller must decide from the message or the transport.
 *
 * One table for the three runtimes, which each had a copy differing in one rule:
 * Claude Code alone mapped 413 to `invalid_request`; OpenCode alone mapped 408 to
 * `request_timeout` and the remaining 4xx to `invalid_request`; Codex and Claude
 * Code recognized only 400 and 422 among the 4xx, and Claude Code read 503 as
 * `server_error` rather than `server_overloaded`. Reading a missing status as
 * `connection_failed` was OpenCode's rule too, but stays at its call site: only
 * OpenCode's `APIError` means "the provider never answered" by it.
 */
export function statusToTurnCode(status: number | undefined): TurnErrorCode | undefined {
  if (status === undefined) return undefined;
  if (status === 401 || status === 403) return "authentication_error";
  if (status === 404) return "resource_not_found";
  if (status === 408) return "request_timeout";
  if (status === 429) return "rate_limit_exceeded";
  if (status === 503 || status === 529) return "server_overloaded";
  if (status >= 500) return "server_error";
  if (status >= 400) return "invalid_request";
  return undefined;
}

/** Retained native events per execution, including streamed deltas and completed items. */
export const EVENT_LOG_LIMIT = 8_000_000;

/**
 * The one "wait, or give up after a grace period" policy: true when `wait` completed
 * before `bound` elapsed. Opts back into interruption so the bound also holds inside
 * finalizers, which otherwise run uninterruptibly.
 */
export const within = (
  wait: Effect.Effect<void>,
  bound: Duration.DurationInput,
): Effect.Effect<boolean> =>
  wait.pipe(Effect.interruptible, Effect.timeoutOption(bound), Effect.map(Option.isSome));

/**
 * An edge trigger between callback land and fibers: `notify()` is synchronous (native
 * SDK callbacks have no fiber), `wait()` suspends until the next notification.
 * Capture `wait()` before reading the state it guards, so a change that lands after
 * the read completes that exact deferred and no wake-up is lost.
 */
export class Wake {
  private pending = Deferred.unsafeMake<void>(FiberId.none);
  wait(): Effect.Effect<void> {
    return Deferred.await(this.pending);
  }
  notify(): void {
    const current = this.pending;
    this.pending = Deferred.unsafeMake<void>(FiberId.none);
    Deferred.unsafeDone(current, Effect.void);
  }
}

/**
 * The retained event log and outcome of one job. Native callbacks mutate it
 * synchronously (they run outside any fiber); readers `poll` as an Effect that
 * can wait for the next change. Terminal outcomes are absorbing.
 */
export class JobLog {
  private readonly state = MutableRef.make<JobState>({
    outcome: { status: "running" },
    cancelling: false,
    closing: false,
    events: Chunk.empty(),
    bytes: 0,
  });
  private readonly wake = new Wake();
  get status() {
    return MutableRef.get(this.state).outcome.status;
  }
  get closing() {
    return MutableRef.get(this.state).closing;
  }
  /** Cancellation was requested; the log still accepts the runtime's final events. */
  get cancelling() {
    return MutableRef.get(this.state).cancelling;
  }
  private update(f: (state: JobState) => JobState): void {
    const before = MutableRef.get(this.state);
    const after = f(before);
    if (after === before) return;
    MutableRef.set(this.state, after);
    this.wake.notify();
  }
  setStatus(status: "running" | "waiting" | "completed" | "cancelled"): void {
    this.update((state) => {
      if (settled(state.outcome) || state.closing) return state;
      // Once cancellation is requested, a task that finishes because its children
      // were cancelled reads as cancelled, and progress transitions are ignored.
      if (state.cancelling)
        return status === "completed" || status === "cancelled"
          ? { ...state, outcome: { status: "cancelled" as const } }
          : state;
      return { ...state, outcome: { status } };
    });
  }
  /** Completion can no longer seal the job; events are recorded until `close()`. */
  requestCancel(): void {
    this.update((state) =>
      settled(state.outcome) || state.closing ? state : { ...state, cancelling: true },
    );
  }
  fail(error: string): void {
    this.update((state) =>
      settled(state.outcome) || state.closing
        ? state
        : { ...state, outcome: { status: "failed" as const, error } },
    );
  }
  close(): void {
    this.update((state) =>
      state.closing
        ? state
        : {
            ...state,
            closing: true,
            outcome: settled(state.outcome) ? state.outcome : { status: "cancelled" as const },
          },
    );
  }
  /**
   * Append an event. Returns false when the event was not retained: the job is
   * terminal or closing, or the retained log would exceed its limit. Exceeding the
   * limit fails the job with `native_output_limit`; callers stop the runtime.
   */
  emit(event: RuntimeEvent): boolean {
    let retained = false;
    this.update((state) => {
      if (settled(state.outcome) || state.closing) return state;
      const bytes = state.bytes + new TextEncoder().encode(JSON.stringify(event)).byteLength;
      if (bytes > EVENT_LOG_LIMIT)
        return { ...state, outcome: { status: "failed" as const, error: "native_output_limit" } };
      retained = true;
      return {
        ...state,
        bytes,
        events: Chunk.append(state.events, { seq: state.events.length + 1, event }),
      };
    });
    return retained;
  }
  private page(state: JobState, after: number): RuntimeBatch {
    const events = Chunk.toArray(Chunk.take(Chunk.drop(state.events, after), 128));
    const more = after + events.length < state.events.length;
    return {
      events,
      cursor: events.at(-1)?.seq ?? after,
      status: more ? "running" : state.outcome.status,
      ...(state.outcome.status === "failed" ? { error: state.outcome.error } : {}),
    };
  }
  /**
   * Events after `after`. Returns at once when there are any or the outcome is
   * terminal; otherwise waits up to `wait` for the next change before answering.
   */
  poll(
    after: number,
    wait: Duration.DurationInput = 0,
  ): Effect.Effect<RuntimeBatch, InvalidCursor> {
    return Effect.gen(this, function* () {
      const woken = this.wake.wait();
      let state = MutableRef.get(this.state);
      if (!Number.isSafeInteger(after) || after < 0 || after > state.events.length)
        return yield* new InvalidCursor();
      const news = state.events.length > after || settled(state.outcome);
      if (!news && Duration.toMillis(Duration.decode(wait)) > 0) {
        yield* woken.pipe(Effect.timeoutOption(wait));
        state = MutableRef.get(this.state);
      }
      return this.page(state, after);
    });
  }
}

/** Memoize the entire outcome: an indeterminate write is never replayed on retry. */
export class Operations {
  private readonly entries = Ref.unsafeMake(
    new Map<string, { fingerprint: string; effect: Effect.Effect<void, TaggedFailure> }>(),
  );
  perform(
    id: string,
    input: unknown,
    effect: Effect.Effect<void, TaggedFailure>,
  ): Effect.Effect<void, TaggedFailure> {
    return Effect.gen(this, function* () {
      const fingerprint = canonicalJSON(input);
      const cached = yield* Effect.cached(effect);
      const entry = yield* Ref.modify(this.entries, (entries) => {
        const previous = entries.get(id);
        if (previous) return [previous, entries] as const;
        const created = { fingerprint, effect: cached };
        return [created, new Map(entries).set(id, created)] as const;
      });
      if (entry.fingerprint !== fingerprint)
        return yield* new IdempotencyConflict({
          reason: "Operation ID was used with different input",
        });
      yield* entry.effect;
    });
  }
}

/** Join concurrent callers, cache success, allow retry after a failed attempt. */
export function once<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> {
  const value = SynchronizedRef.unsafeMake<{ readonly value: A } | undefined>(void 0);
  return SynchronizedRef.modifyEffect(value, (saved) =>
    saved
      ? Effect.succeed([saved.value, saved] as const)
      : effect.pipe(Effect.map((resolved) => [resolved, { value: resolved }] as const)),
  );
}
