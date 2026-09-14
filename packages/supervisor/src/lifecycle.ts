import {
  ApiError,
  canonicalJSON,
  io,
  OperationError,
  type RuntimeBatch,
  type RuntimeEvent,
  runSync,
  type ServiceError,
} from "cf-open-agents-api";
import { Cause, Chunk, Effect, Ref, SynchronizedRef } from "effect";

/** Native failure detail for diagnostics; the public batch error stays a stable code. */
export function describeFailure(value: unknown): string {
  const squashed = Cause.isCause(value) ? Cause.squash(value) : value;
  const reason = squashed instanceof OperationError ? squashed.cause : squashed;
  return reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
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

/** All native callbacks share one atomic, immutable state. Terminal outcomes are absorbing. */
export class JobLifecycle {
  private readonly state = Ref.unsafeMake<JobState>({
    outcome: { status: "running" },
    cancelling: false,
    closing: false,
    events: Chunk.empty(),
    bytes: 0,
  });
  readonly transition = Effect.unsafeMakeSemaphore(1);
  get status() {
    return runSync(Ref.get(this.state)).outcome.status;
  }
  get closing() {
    return runSync(Ref.get(this.state)).closing;
  }
  setStatus(status: "running" | "waiting" | "completed" | "cancelled"): void {
    runSync(
      Ref.update(this.state, (state) => {
        if (terminal(state.outcome) || state.closing) return state;
        // Once cancellation is requested, a task that finishes because its children
        // were cancelled reads as cancelled, and progress transitions are ignored.
        if (state.cancelling)
          return status === "completed" || status === "cancelled"
            ? { ...state, outcome: { status: "cancelled" as const } }
            : state;
        return { ...state, outcome: { status } };
      }),
    );
  }
  /** Completion can no longer seal the job; events are recorded until `close()`. */
  requestCancel(): void {
    runSync(
      Ref.update(this.state, (state) =>
        terminal(state.outcome) || state.closing ? state : { ...state, cancelling: true },
      ),
    );
  }
  fail(error: string): void {
    runSync(
      Ref.update(this.state, (state) =>
        terminal(state.outcome) || state.closing
          ? state
          : { ...state, outcome: { status: "failed" as const, error } },
      ),
    );
  }
  close(): void {
    runSync(
      Ref.update(this.state, (state) => ({
        ...state,
        closing: true,
        outcome: terminal(state.outcome) ? state.outcome : { status: "cancelled" as const },
      })),
    );
  }
  /**
   * Append an event. Returns false when the event was not retained: the job is
   * terminal or closing, or the retained log would exceed its limit. Exceeding the
   * limit fails the job with `native_output_limit`; callers stop the runtime.
   */
  emit(event: RuntimeEvent): boolean {
    return runSync(
      Ref.modify(this.state, (state) => {
        if (terminal(state.outcome) || state.closing) return [false, state] as const;
        const bytes = state.bytes + new TextEncoder().encode(JSON.stringify(event)).byteLength;
        if (bytes > EVENT_LOG_LIMIT)
          return [
            false,
            { ...state, outcome: { status: "failed" as const, error: "native_output_limit" } },
          ] as const;
        return [
          true,
          {
            ...state,
            bytes,
            events: Chunk.append(state.events, { seq: state.events.length + 1, event }),
          },
        ] as const;
      }),
    );
  }
  poll(after: number): RuntimeBatch {
    const state = runSync(Ref.get(this.state));
    if (!Number.isSafeInteger(after) || after < 0 || after > state.events.length)
      throw new Error("Invalid event cursor");
    const events = Chunk.toArray(Chunk.take(Chunk.drop(state.events, after), 128));
    const more = after + events.length < state.events.length;
    return {
      events,
      cursor: events.at(-1)?.seq ?? after,
      status: more ? "running" : state.outcome.status,
      ...(state.outcome.status === "failed" ? { error: state.outcome.error } : {}),
    };
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

/** Join concurrent reads/cleanup, cache success, allow retry after a failed attempt. */
export function once<A>(operation: string, f: () => Promise<A>) {
  const value = SynchronizedRef.unsafeMake<{ readonly value: A } | undefined>(undefined);
  return SynchronizedRef.modifyEffect(value, (saved) =>
    saved
      ? Effect.succeed([saved.value, saved] as const)
      : io(operation, f).pipe(Effect.map((value) => [value, { value }] as const)),
  );
}
