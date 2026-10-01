import { Schema } from "effect";

import { Machine } from "../src/index.js";

const Time = Schema.Number.pipe(Schema.int(), Schema.between(0, 4_000_000_000_000));
export const IDLE_MS = 60_000;

/** A container lease: the shape of the HarnessDO lifecycle, small enough to read in a test. */
export const LeaseSpec = Machine.spec({
  name: "lease",
  facts: Schema.Struct({ now: Time, busy: Schema.Number.pipe(Schema.int(), Schema.between(0, 3)) }),
  events: {
    acquire: Schema.Struct({ generation: Schema.Number.pipe(Schema.int(), Schema.between(0, 9)) }),
    started: Schema.Struct({}),
    startFailed: Schema.Struct({ reason: Schema.String }),
    touch: Schema.Struct({}),
    idle: Schema.Struct({}),
    remove: Schema.Struct({}),
  },
  commands: {
    start: Schema.Struct({ generation: Schema.Number }),
    stopContainer: Schema.Struct({ reason: Schema.String }),
    dropSandbox: Schema.Struct({}),
  },
  states: {
    cold: Machine.state(Schema.Struct({})),
    starting: Machine.state(Schema.Struct({ generation: Schema.Number }), {
      holds: ["container"],
    }),
    running: Machine.state(Schema.Struct({ generation: Schema.Number, lastActive: Time }), {
      holds: ["container", "sandbox"],
    }),
    removed: Machine.terminal(Schema.Struct({})),
  },
});
export type Lease = typeof LeaseSpec;

export const lease = Machine.make(LeaseSpec, {
  initial: { _tag: "cold", data: {} },
  on: {
    cold: {
      acquire: (_data, event) => ({
        to: "starting",
        data: { generation: event.generation },
        commands: [{ _tag: "start", generation: event.generation }],
      }),
      started: "ignore",
      startFailed: "ignore",
      touch: "ignore",
      idle: "ignore",
      remove: () => ({ to: "removed", data: {} }),
    },
    starting: {
      acquire: "reject",
      started: (data, _event, facts) => ({
        to: "running",
        data: { generation: data.generation, lastActive: facts.now },
      }),
      startFailed: () => ({ to: "cold", data: {} }),
      touch: "ignore",
      idle: "ignore",
      remove: () => ({ to: "removed", data: {} }),
    },
    running: {
      acquire: "reject",
      started: "ignore",
      startFailed: "ignore",
      touch: (data, _event, facts) => ({
        to: "running",
        data: { ...data, lastActive: Math.max(data.lastActive, facts.now) },
      }),
      idle: (data, _event, facts) =>
        facts.busy > 0 || facts.now < data.lastActive + IDLE_MS
          ? { to: "running", data }
          : { to: "cold", data: {} },
      remove: () => ({ to: "removed", data: {} }),
    },
  },
  timers: { running: (data) => ({ idle: data.lastActive + IDLE_MS }) },
  // Declaration order is release order: the container stops before the sandbox goes.
  release: {
    container: () => ({ _tag: "stopContainer", reason: "released" }),
    sandbox: () => ({ _tag: "dropSandbox" }),
  },
});
