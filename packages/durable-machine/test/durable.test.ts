import { Data, Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";

import {
  DurableMachine,
  type Event,
  EventRejected,
  type MachineStore,
  memoryStore,
} from "../src/index.js";
import { IDLE_MS, type Lease, lease } from "./fixture.js";

class CommandFailed extends Data.TaggedError("CommandFailed")<{ readonly command: string }> {}

interface World {
  now: number;
  busy: number;
  log: string[];
  armed: Array<number | null>;
  /** Commands that fail while set, by tag. */
  failing: Set<string>;
  /** The event `start` answers with. */
  startAnswer: Event<Lease> | undefined;
  /** Runs while `start` is in flight, like a request that lands meanwhile. */
  duringStart?: () => void;
}

const world = (): World => ({
  now: 1000,
  busy: 0,
  log: [],
  armed: [],
  failing: new Set(),
  startAnswer: { _tag: "started" },
});

const runtime = (store: MachineStore, w: World) =>
  DurableMachine.make({
    machine: lease,
    store,
    clock: () => w.now,
    facts: () => ({ now: w.now, busy: w.busy }),
    arm: (at) => w.armed.push(at),
    handlers: {
      start: (command, context) =>
        w.failing.has("start")
          ? Effect.fail(new CommandFailed({ command: "start" }))
          : Effect.sync(() => {
              w.log.push(`start ${command.generation} #${context.id}/${context.attempt}`);
              w.duringStart?.();
              return w.startAnswer;
            }),
      stopContainer: (command) =>
        w.failing.has("stopContainer")
          ? Effect.fail(new CommandFailed({ command: "stopContainer" }))
          : Effect.sync(() => {
              w.log.push(`stopContainer ${command.reason}`);
            }),
      dropSandbox: () =>
        Effect.sync(() => {
          w.log.push("dropSandbox");
        }),
    },
  });

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);

describe("durable runtime", () => {
  it("commits the transition, runs its command and applies the result", async () => {
    const w = world();
    const machine = runtime(memoryStore(), w);
    await run(machine.send({ _tag: "acquire", generation: 1 }));
    expect(w.log).toEqual(["start 1 #1/1"]);
    expect(machine.current()).toEqual({
      _tag: "running",
      data: { generation: 1, lastActive: 1000 },
    });
    expect(machine.epoch()).toBe(2);
    expect(machine.nextWake()).toBe(1000 + IDLE_MS);
    expect(w.armed.at(-1)).toBe(1000 + IDLE_MS);
  });

  it("fails a rejected event without writing", async () => {
    const w = world();
    const machine = runtime(memoryStore(), w);
    await run(machine.send({ _tag: "acquire", generation: 1 }));
    const exit = await Effect.runPromiseExit(machine.send({ _tag: "acquire", generation: 2 }));
    expect(Exit.isFailure(exit) && exit.cause._tag === "Fail" && exit.cause.error).toBeInstanceOf(
      EventRejected,
    );
    expect(machine.current()._tag).toBe("running");
  });

  it("releases every resource on removal, in order, and keeps the terminal state", async () => {
    const w = world();
    const machine = runtime(memoryStore(), w);
    await run(machine.send({ _tag: "acquire", generation: 1 }));
    await run(machine.send({ _tag: "remove" }));
    expect(w.log.slice(1)).toEqual(["stopContainer released", "dropSandbox"]);
    expect(machine.current()._tag).toBe("removed");
    expect(machine.nextWake()).toBeNull();
  });

  it("drops a command whose state moved on before it ran, but still runs releases", async () => {
    const w = world();
    const machine = runtime(memoryStore(), w);
    machine.apply({ _tag: "acquire", generation: 1 });
    machine.apply({ _tag: "remove" });
    await run(machine.drain);
    expect(w.log).toEqual(["stopContainer released"]);
  });

  it("drops a result that arrives after the state moved on", async () => {
    const w = world();
    const machine = runtime(memoryStore(), w);
    w.duringStart = () => machine.apply({ _tag: "remove" });
    await run(machine.send({ _tag: "acquire", generation: 1 }));
    // `started` belonged to the starting epoch; the removal's release still ran.
    expect(machine.current()._tag).toBe("removed");
    expect(w.log).toEqual(["start 1 #1/1", "stopContainer released"]);
  });

  it("retries a failed command with backoff and blocks the commands behind it", async () => {
    const w = world();
    const machine = runtime(memoryStore(), w);
    await run(machine.send({ _tag: "acquire", generation: 1 }));
    w.failing.add("stopContainer");
    await run(machine.send({ _tag: "remove" }));
    expect(w.log).toEqual(["start 1 #1/1"]);
    expect(machine.nextWake()).toBe(1000 + 1000);
    w.failing.clear();
    await run(machine.drain);
    expect(w.log).toHaveLength(1);
    w.now += 1000;
    await run(machine.wake);
    expect(w.log.slice(1)).toEqual(["stopContainer released", "dropSandbox"]);
  });

  it("recovers commands left behind by an evicted object", async () => {
    const w = world();
    const store = memoryStore();
    runtime(store, w).apply({ _tag: "acquire", generation: 4 });
    // The object was evicted before draining; a fresh instance over the same storage wakes.
    const fresh = runtime(store, w);
    expect(fresh.nextWake()).toBe(1000 + 5000);
    w.now += 5000;
    await run(fresh.wake);
    expect(w.log).toEqual(["start 4 #1/1"]);
    expect(fresh.current()._tag).toBe("running");
  });

  it("fires a timer once per deadline, and again for a new deadline", async () => {
    const w = world();
    const machine = runtime(memoryStore(), w);
    await run(machine.send({ _tag: "acquire", generation: 1 }));
    w.now = 1000 + IDLE_MS;
    w.busy = 1;
    await run(machine.wake);
    // Busy: the idle check keeps the state and its deadline, and does not fire again.
    expect(machine.current()._tag).toBe("running");
    expect(machine.nextWake()).toBeNull();
    w.busy = 0;
    await run(machine.send({ _tag: "touch" }));
    expect(machine.nextWake()).toBe(1000 + 2 * IDLE_MS);
    w.now = 1000 + 2 * IDLE_MS;
    await run(machine.wake);
    expect(machine.current()._tag).toBe("cold");
    expect(w.log.slice(1)).toEqual(["stopContainer released", "dropSandbox"]);
  });

  it("rolls the transition back with the host's writes when either throws", () => {
    const w = world();
    const store = memoryStore();
    const machine = runtime(store, w);
    expect(() =>
      machine.apply({ _tag: "acquire", generation: 1 }, () => {
        throw new Error("host write failed");
      }),
    ).toThrow("host write failed");
    expect(machine.current()._tag).toBe("cold");
    expect(store.outbox("lease")).toEqual([]);
  });
});
