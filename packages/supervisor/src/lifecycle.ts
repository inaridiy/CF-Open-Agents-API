import {
  ApiError,
  canonicalJSON,
  io,
  type RuntimeBatch,
  type RuntimeEvent,
  runSync,
  type ServiceError,
} from "cf-open-agents-api";
import { Chunk, Effect, Ref, SynchronizedRef } from "effect";

type Outcome =
  | { readonly status: "running" | "waiting" }
  | { readonly status: "completed" | "cancelled" }
  | { readonly status: "failed"; readonly error: string };
interface JobState {
  readonly outcome: Outcome;
  readonly closing: boolean;
  readonly events: Chunk.Chunk<RuntimeBatch["events"][number]>;
  readonly bytes: number;
}
const terminal = (outcome: Outcome) => outcome.status !== "running" && outcome.status !== "waiting";

/** All native callbacks share one atomic, immutable state. Terminal outcomes are absorbing. */
export class JobLifecycle {
  private readonly state = Ref.unsafeMake<JobState>({
    outcome: { status: "running" },
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
      Ref.update(this.state, (state) =>
        terminal(state.outcome) || state.closing ? state : { ...state, outcome: { status } },
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
  emit(event: RuntimeEvent): void {
    runSync(
      Ref.update(this.state, (state) => {
        if (terminal(state.outcome) || state.closing) return state;
        const bytes = state.bytes + new TextEncoder().encode(JSON.stringify(event)).byteLength;
        if (bytes > 8_000_000) throw new Error("Native event buffer exceeds its limit");
        return {
          ...state,
          bytes,
          events: Chunk.append(state.events, { seq: state.events.length + 1, event }),
        };
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
