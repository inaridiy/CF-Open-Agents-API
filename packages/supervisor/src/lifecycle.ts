import {
  ApiError,
  canonicalJSON,
  OperationError,
  type RuntimeBatch,
  type RuntimeEvent,
  type ServiceError,
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
  Ref,
  SynchronizedRef,
} from "effect";

/** Native failure detail for diagnostics; the public batch error stays a stable code. */
export function describeFailure(value: unknown): string {
  const squashed = Cause.isCause(value) ? Cause.squash(value) : value;
  const reason = squashed instanceof OperationError ? squashed.cause : squashed;
  return reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
}

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
const terminal = (outcome: Outcome) => outcome.status !== "running" && outcome.status !== "waiting";
/**
 * Public turn error codes of the OpenAI Agents API (`SessionTurnError.code` in
 * openai@7.15.0). Supervisors fail a job with one of these; other strings reach
 * the client as `internal_error` with the string as the message.
 */
export const TURN_ERROR_CODES = [
  "context_length_exceeded",
  "session_budget_exceeded",
  "usage_limit_exceeded",
  "rate_limit_exceeded",
  "server_overloaded",
  "cyber_policy",
  "connection_failed",
  "server_error",
  "authentication_error",
  "invalid_request",
  "resource_not_found",
  "sandbox_error",
  "executor_version_incompatible",
  "active_turn_not_steerable",
  "request_timeout",
  "internal_error",
] as const;
export type TurnErrorCode = (typeof TURN_ERROR_CODES)[number];

/** Retained native events per execution, including streamed deltas and completed items. */
export const EVENT_LOG_LIMIT = 8_000_000;

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
      if (terminal(state.outcome) || state.closing) return state;
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
      terminal(state.outcome) || state.closing ? state : { ...state, cancelling: true },
    );
  }
  fail(error: string): void {
    this.update((state) =>
      terminal(state.outcome) || state.closing
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
            outcome: terminal(state.outcome) ? state.outcome : { status: "cancelled" as const },
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
      if (terminal(state.outcome) || state.closing) return state;
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
      const news = state.events.length > after || terminal(state.outcome);
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
    new Map<string, { fingerprint: string; effect: Effect.Effect<void, ServiceError> }>(),
  );
  perform(id: string, input: unknown, effect: Effect.Effect<void, ServiceError>) {
    return Effect.gen(this, function* () {
      const fingerprint = canonicalJSON(input);
      const cached = yield* Effect.cached(effect);
      const entry = yield* Ref.modify(this.entries, (entries) => {
        const previous = entries.get(id);
        if (previous) return [previous, entries] as const;
        const entry = { fingerprint, effect: cached };
        return [entry, new Map(entries).set(id, entry)] as const;
      });
      if (entry.fingerprint !== fingerprint)
        return yield* new ApiError(
          409,
          "idempotency_conflict",
          "Operation ID was used with different input",
        );
      yield* entry.effect;
    });
  }
}

/** Join concurrent callers, cache success, allow retry after a failed attempt. */
export function once<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> {
  const value = SynchronizedRef.unsafeMake<{ readonly value: A } | undefined>(undefined);
  return SynchronizedRef.modifyEffect(value, (saved) =>
    saved
      ? Effect.succeed([saved.value, saved] as const)
      : effect.pipe(Effect.map((value) => [value, { value }] as const)),
  );
}
