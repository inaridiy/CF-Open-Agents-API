import { DurableMachine, Machine, sqliteStore } from "durable-machine";
import { Cause, Effect, Schema } from "effect";

import type { ServiceError } from "../effect.js";
import { ContainerMisconfigured, ContainerRetired, TransportFailure } from "../errors.js";

const Time = Schema.Number.pipe(Schema.int(), Schema.between(0, 8_640_000_000_000_000));
const MIN_IDLE_MS = 1000;
const MAX_IDLE_MS = 6 * 60 * 60 * 1000;
const Duration = Schema.Number.pipe(Schema.int(), Schema.between(MIN_IDLE_MS, MAX_IDLE_MS));

/**
 * The lifecycle of the one container a Durable Object owns. `running` holds the container,
 * so every way out of it (idle, a failed boot, a stop, the session's deletion) destroys
 * it; `retired` is terminal, so nothing starts a container for a deleted session again.
 * Whether the container still runs is a fact the object observes, so a container the
 * platform stopped is booted again instead of being trusted.
 */
export const ContainerLease = Machine.spec({
  name: "container",
  facts: Schema.Struct({
    now: Time,
    /** Requests in flight that use the container; an idle check never ends a busy one. */
    busy: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
    containerRunning: Schema.Boolean,
    /** A boot command is queued and has not finished; another one would only pile up. */
    bootPending: Schema.Boolean,
  }),
  events: {
    need: Schema.Struct({ idleMs: Duration }),
    touch: Schema.Struct({}),
    idle: Schema.Struct({}),
    bootFailed: Schema.Struct({ reason: Schema.String }),
    stop: Schema.Struct({ reason: Schema.String }),
    retire: Schema.Struct({}),
  },
  commands: {
    boot: Schema.Struct({}),
    destroy: Schema.Struct({}),
  },
  states: {
    stopped: Machine.state(Schema.Struct({})),
    running: Machine.state(Schema.Struct({ since: Time, lastActive: Time, idleMs: Duration }), {
      holds: ["container"],
    }),
    retired: Machine.terminal(Schema.Struct({})),
  },
});
type Lease = typeof ContainerLease;

const stopped = { to: "stopped", data: {} } as const;
const retired = { to: "retired", data: {} } as const;

export const containerLease = Machine.make(ContainerLease, {
  initial: { _tag: "stopped", data: {} },
  on: {
    stopped: {
      need: (_data, event, facts) => ({
        to: "running",
        data: { since: facts.now, lastActive: facts.now, idleMs: event.idleMs },
        commands: [{ _tag: "boot" }],
      }),
      touch: "ignore",
      idle: "ignore",
      bootFailed: "ignore",
      stop: "ignore",
      retire: () => retired,
    },
    running: {
      need: (data, event, facts) =>
        facts.containerRunning || facts.bootPending
          ? {
              to: "running",
              data: {
                ...data,
                lastActive: Math.max(data.lastActive, facts.now),
                idleMs: event.idleMs,
              },
            }
          : {
              // The platform stopped it (a crash, a host restart): boot a new one.
              to: "running",
              data: { since: facts.now, lastActive: facts.now, idleMs: event.idleMs },
              commands: [{ _tag: "boot" }],
            },
      touch: (data, _event, facts) => ({
        to: "running",
        data: { ...data, lastActive: Math.max(data.lastActive, facts.now) },
      }),
      idle: (data, _event, facts) => {
        if (facts.busy > 0) return { to: "running", data: { ...data, lastActive: facts.now } };
        if (facts.now < data.lastActive + data.idleMs) return { to: "running", data };
        return stopped;
      },
      bootFailed: () => stopped,
      stop: () => stopped,
      retire: () => retired,
    },
  },
  timers: { running: (data) => ({ idle: data.lastActive + data.idleMs }) },
  release: { container: () => ({ _tag: "destroy" }) },
});

export interface LeaseOptions {
  readonly storage: DurableObjectStorage;
  readonly container: () => Container | undefined;
  /** Starts the container if it is not running and prepares it; safe to repeat. */
  readonly boot: Effect.Effect<void, ServiceError>;
  readonly destroy: Effect.Effect<void, ServiceError>;
  readonly idleMs: () => number;
  /** Names the object in logs. */
  readonly label: string;
}

/** Touches closer together than this are not written; the idle deadline moves anyway. */
const TOUCH_INTERVAL_MS = 15_000;

/**
 * The lease as the object uses it: `acquire` before using the container, `hold` around a
 * use, `stop` and `retire` from the entrypoints, `wake` from the alarm. The object's single
 * alarm belongs to the lease.
 */
export function makeLease(options: LeaseOptions) {
  let busy = 0;
  /** Why the last boot failed, so a misconfigured deployment is told so instead of "retry". */
  let bootError: unknown;
  const store = sqliteStore(options.storage);
  const bootPending = () =>
    store.outbox(containerLease.name).some((entry) => entry.command._tag === "boot");
  const running = () => options.container()?.running ?? false;
  const machine = DurableMachine.make({
    machine: containerLease,
    store,
    facts: () => ({
      now: Date.now(),
      busy,
      containerRunning: running(),
      bootPending: bootPending(),
    }),
    arm: (at) => {
      if (at === null) void options.storage.deleteAlarm();
      else void options.storage.setAlarm(at);
    },
    handlers: {
      // A failed boot (a defect included) ends the running state, which destroys whatever
      // half-started; the next `acquire` boots again.
      boot: () =>
        Effect.suspend(() => options.boot).pipe(
          Effect.tap(() => Effect.sync(() => (bootError = undefined))),
          Effect.asVoid,
          Effect.catchAllCause((cause) => {
            bootError = Cause.squash(cause);
            return Effect.logWarning("Container boot failed", {
              object: options.label,
              cause,
            }).pipe(
              Effect.as({ _tag: "bootFailed" as const, reason: Cause.pretty(cause).slice(0, 512) }),
            );
          }),
        ),
      // Nothing to destroy is not a failure: a destroy must never block the boots behind it.
      destroy: () => (running() ? options.destroy : Effect.void),
    },
  });
  const state = () => machine.current();
  const touch = Effect.sync(() => {
    const current = state();
    if (current._tag !== "running" || Date.now() - current.data.lastActive < TOUCH_INTERVAL_MS)
      return;
    machine.apply({ _tag: "touch" });
  });
  const idleMs = () => Math.min(MAX_IDLE_MS, Math.max(MIN_IDLE_MS, Math.round(options.idleMs())));
  const need = Effect.suspend(() => machine.send({ _tag: "need", idleMs: idleMs() })).pipe(
    Effect.catchTag("EventRejected", () => Effect.void),
  );
  const held: Effect.Effect<void, ContainerRetired | ContainerMisconfigured | TransportFailure> =
    Effect.gen(function* () {
      const current = state();
      if (current._tag === "retired") return yield* new ContainerRetired();
      if (bootError instanceof ContainerMisconfigured) return yield* bootError;
      // A boot still queued (behind a destroy that keeps failing, say) has not prepared the
      // container this request would use.
      if (current._tag !== "running" || !running() || bootPending())
        return yield* new TransportFailure({
          operation: `${options.label}.start`,
          cause: bootPending() ? "Container is still starting" : "Container did not start",
        });
    });
  /**
   * The container runs and the lease holds it; a deleted session's object refuses. A running
   * container is only touched (at most one write per interval) and waits for a boot in flight.
   */
  const acquire: Effect.Effect<void, ContainerRetired | ContainerMisconfigured | TransportFailure> =
    Effect.suspend(() =>
      state()._tag === "running" && running() ? Effect.zipRight(touch, machine.drain) : need,
    ).pipe(Effect.zipRight(held));
  /** `acquire`, always through the transition, so a changed `idleMs()` takes effect now. */
  const renew = need.pipe(Effect.zipRight(held));
  /** Marks the container busy for the length of `use`, so no idle check ends it meanwhile. */
  const hold = <A, E, R>(use: Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        busy += 1;
      }),
      () => use,
      () =>
        Effect.sync(() => {
          busy -= 1;
        }).pipe(Effect.zipRight(touch)),
    );
  return {
    state,
    acquire,
    renew,
    hold,
    touch,
    /** Ends the container now; the next `acquire` boots a fresh one. */
    stop: (reason: string) =>
      machine.send({ _tag: "stop", reason }).pipe(Effect.asVoid, Effect.orDie),
    /** Ends the container for good: the session was deleted. */
    retire: machine.send({ _tag: "retire" }).pipe(Effect.asVoid, Effect.orDie),
    wake: machine.wake,
    /** Busy requests now; for diagnostics and tests. */
    busy: () => busy,
  };
}
export type ContainerLeaseHandle = ReturnType<typeof makeLease>;
export type { Lease };
