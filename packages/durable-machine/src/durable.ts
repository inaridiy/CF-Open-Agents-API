import { Cause, Effect, Exit } from "effect";

import { EventRejected } from "./errors.js";
import type {
  Command,
  CommandTag,
  Encoded,
  Event,
  Facts,
  Machine,
  Spec,
  State,
  Step,
} from "./machine.js";
import type { MachineStore, OutboxEntry } from "./store.js";

export interface CommandContext {
  /** Stable across retries: use it to make the command idempotent. */
  readonly id: number;
  /** 1 on the first run. */
  readonly attempt: number;
}

/**
 * Runs each command after the transaction that enqueued it committed. A handler may
 * answer with an event; it is applied only while the state is still in the epoch that
 * enqueued the command. A failure is retried with backoff and blocks the commands behind
 * it, so releases keep their order. A handler that wants a failure to change the state
 * catches it and returns an event instead.
 */
export type Handlers<S extends Spec, E, R> = {
  readonly [C in CommandTag<S>]: (
    command: Command<S, C>,
    context: CommandContext,
  ) => Effect.Effect<Event<S> | void, E, R>;
};

/** The services the handlers need. */
export type HandlerContext<H> = {
  [C in keyof H]: H[C] extends (...args: never[]) => Effect.Effect<unknown, unknown, infer R>
    ? R
    : never;
}[keyof H];

export interface Options<S extends Spec, H extends Handlers<S, unknown, unknown>> {
  readonly machine: Machine<S>;
  readonly store: MachineStore;
  /** Distinguishes several instances of one machine in the same store. Defaults to the machine name. */
  readonly key?: string;
  /** Observed by the host at each dispatch. */
  readonly facts: () => Facts<S>;
  readonly handlers: H;
  /** Epoch milliseconds; defaults to `Date.now`. */
  readonly clock?: () => number;
  /**
   * Called synchronously after every commit with the next time this machine needs to run
   * (a timer or a pending command), or `null`. In a Durable Object, call
   * `ctx.storage.setAlarm` here without awaiting in between, so the alarm and the
   * transaction are written together.
   */
  readonly arm?: (at: number | null) => void;
  /** Delay before retry `attempt` (1-based) of a failed command. Defaults to 1 s doubling to 60 s. */
  readonly retryDelay?: (attempt: number) => number;
  /**
   * How long a new command waits for the request that enqueued it to run it before the
   * alarm does. A request that is evicted mid-command leaves its command to the alarm.
   */
  readonly recoveryDelay?: number;
}

export interface Durable<S extends Spec, R> {
  readonly machine: Machine<S>;
  current(): State<S>;
  epoch(): number;
  /**
   * Applies one event in one transaction, synchronously, and arms the alarm. Commands run
   * on the next `drain`. `alongside` runs inside the same transaction, for the host's own
   * writes that must commit with the transition.
   */
  apply(event: Event<S>, alongside?: (step: Step<S>) => void): Step<S>;
  /** `apply` as an Effect; a rejected event is a failure. */
  dispatch(event: Event<S>): Effect.Effect<Step<S>, EventRejected>;
  /** `dispatch`, then `drain`. */
  send(event: Event<S>): Effect.Effect<Step<S>, EventRejected, R>;
  /** Runs pending commands that are due. Never fails: failures are recorded and retried. */
  readonly drain: Effect.Effect<void, never, R>;
  /** The alarm entry: fires due timers, then drains. */
  readonly wake: Effect.Effect<void, never, R>;
  nextWake(): number | null;
}

const defaultRetry = (attempt: number) => Math.min(60_000, 1000 * 2 ** (attempt - 1));
/** Bound on timer firings in one wake, against a table that keeps a timer due. */
const MAX_FIRINGS = 64;

interface Record_<S extends Spec> {
  readonly state: State<S>;
  readonly epoch: number;
  /** Deadlines already fired, by timer event, so a timer fires once per deadline. */
  readonly fired: { readonly [event: string]: number };
}

export function make<S extends Spec, H extends Handlers<S, unknown, unknown>>(
  options: Options<S, H>,
): Durable<S, HandlerContext<H>> {
  type R = HandlerContext<H>;
  const { machine, store } = options;
  const key = options.key ?? machine.name;
  const clock = options.clock ?? Date.now;
  const retryDelay = options.retryDelay ?? defaultRetry;
  const recoveryDelay = options.recoveryDelay ?? 5000;
  const permit = Effect.unsafeMakeSemaphore(1);
  for (const tag of Object.keys(machine.spec.commands))
    if (typeof (options.handlers as Record<string, unknown>)[tag] !== "function")
      throw new Error(`durable-machine ${key}: command ${tag} has no handler`);

  const load = (): Record_<S> => {
    const stored = store.load(key);
    if (!stored) return { state: machine.initial, epoch: 0, fired: {} };
    const encoded = stored.state as Encoded & { fired?: Record<string, number> };
    const { fired = {}, ...state } = encoded;
    return { state: machine.decodeState(state), epoch: stored.epoch, fired };
  };
  const save = (record: Record_<S>) =>
    store.save(key, {
      state: { ...machine.encodeState(record.state), fired: record.fired },
      epoch: record.epoch,
    });

  const pendingTimers = (record: Record_<S>) =>
    machine.timers(record.state).filter((timer) => record.fired[timer.event] !== timer.at);
  const nextWake = (): number | null => {
    const times = [
      ...pendingTimers(load()).map((timer) => timer.at),
      ...store.outbox(key).map((entry) => entry.due),
    ];
    return times.length ? Math.min(...times) : null;
  };
  const arm = () => options.arm?.(nextWake());

  /** One transition inside the caller's transaction. */
  const transition = (record: Record_<S>, event: Event<S>, now: number): Step<S> => {
    const step = machine.step(record.state, event, options.facts());
    if (step._tag !== "Moved") return step;
    const epoch = step.entered ? record.epoch + 1 : record.epoch;
    save({ state: step.to, epoch, fired: step.entered ? {} : record.fired });
    for (const planned of step.commands)
      store.enqueue(key, {
        command: machine.encodeCommand(planned.command),
        epoch,
        release: planned.release,
        attempts: 0,
        due: now + recoveryDelay,
      });
    return step;
  };

  const apply = (event: Event<S>, alongside?: (step: Step<S>) => void): Step<S> => {
    const step = store.transaction(() => {
      const result = transition(load(), event, clock());
      alongside?.(result);
      return result;
    });
    arm();
    return step;
  };

  const dispatch = (event: Event<S>) =>
    Effect.suspend(() => {
      const step = apply(event);
      return step._tag === "Rejected"
        ? Effect.fail(
            new EventRejected({
              machine: machine.name,
              state: step.state._tag,
              event: String(event._tag),
            }),
          )
        : Effect.succeed(step);
    });

  type Taken =
    | { readonly _tag: "Run"; readonly entry: OutboxEntry; readonly command: Command<S> }
    | { readonly _tag: "Skipped" }
    | { readonly _tag: "Idle" };
  /** The next command to run, dropping stale non-release commands on the way. */
  const take = (now: number): Taken =>
    store.transaction(() => {
      const [entry] = store.outbox(key);
      if (!entry) return { _tag: "Idle" };
      if (!entry.release && entry.epoch !== load().epoch) {
        store.remove(entry.id);
        return { _tag: "Skipped" };
      }
      if (entry.attempts > 0 && entry.due > now) return { _tag: "Idle" };
      return { _tag: "Run", entry, command: machine.decodeCommand(entry.command) };
    });

  const runOne = (entry: OutboxEntry, command: Command<S>) => {
    const tag = String(command._tag);
    const handlers = options.handlers as unknown as Record<
      string,
      (command: Command<S>, context: CommandContext) => Effect.Effect<Event<S> | void, unknown, R>
    >;
    const handler = handlers[tag];
    if (!handler) return Effect.die(new Error(`durable-machine ${key}: no handler for ${tag}`));
    const attempt = entry.attempts + 1;
    return Effect.exit(handler(command, { id: entry.id, attempt })).pipe(
      Effect.flatMap((exit) => {
        if (Exit.isSuccess(exit)) {
          const stale = store.transaction(() => {
            store.remove(entry.id);
            const record = load();
            const result = exit.value;
            if (!result) return false;
            if (record.epoch !== entry.epoch) return true;
            transition(record, result, clock());
            return false;
          });
          arm();
          return stale
            ? Effect.logDebug("durable-machine: dropped a stale command result").pipe(
                Effect.annotateLogs({ machine: key, command: command._tag }),
                Effect.as(true),
              )
            : Effect.succeed(true);
        }
        if (Cause.isInterruptedOnly(exit.cause)) return Effect.interrupt;
        store.transaction(() => store.reschedule(entry.id, attempt, clock() + retryDelay(attempt)));
        arm();
        return Effect.logWarning("durable-machine: command failed; it will be retried").pipe(
          Effect.annotateLogs({ machine: key, command: command._tag, attempt }),
          Effect.zipRight(Effect.logWarning(exit.cause)),
          Effect.as(false),
        );
      }),
    );
  };

  const drain: Effect.Effect<void, never, R> = permit.withPermits(1)(
    Effect.gen(function* () {
      for (;;) {
        const taken = take(clock());
        if (taken._tag === "Idle") break;
        if (taken._tag === "Skipped") {
          arm();
          continue;
        }
        if (!(yield* runOne(taken.entry, taken.command))) break;
      }
    }),
  );

  const fireTimers = Effect.sync(() => {
    for (let firing = 0; firing < MAX_FIRINGS; firing++) {
      const fired = store.transaction(() => {
        const record = load();
        const now = clock();
        const [timer] = pendingTimers(record).filter((pending) => pending.at <= now);
        if (!timer) return false;
        // Mark first: an event the state ignores, or a transition that keeps the deadline,
        // must not fire the same deadline again.
        const marked = { ...record, fired: { ...record.fired, [timer.event]: timer.at } };
        save(marked);
        transition(marked, { _tag: timer.event } as Event<S>, now);
        return true;
      });
      if (!fired) break;
    }
    arm();
  });

  return {
    machine,
    current: () => load().state,
    epoch: () => load().epoch,
    apply,
    dispatch,
    send: (event) => Effect.tap(dispatch(event), () => drain),
    drain,
    wake: Effect.zipRight(fireTimers, drain),
    nextWake,
  };
}
