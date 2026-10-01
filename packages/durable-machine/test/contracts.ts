/**
 * Compile-time contracts: each `@ts-expect-error` below is a lifecycle bug the types reject.
 * `pnpm typecheck` fails when one of them starts compiling.
 */
import { type Implementation, Machine } from "../src/index.js";
import { type Lease, LeaseSpec, lease } from "./fixture.js";

type LeaseImplementation = Implementation<Lease>;
const base: LeaseImplementation = {
  initial: lease.initial as LeaseImplementation["initial"],
  on: {
    cold: {
      acquire: "reject",
      started: "ignore",
      startFailed: "ignore",
      touch: "ignore",
      idle: "ignore",
      remove: () => ({ to: "removed", data: {} }),
    },
    starting: {
      acquire: "reject",
      started: "ignore",
      startFailed: "ignore",
      touch: "ignore",
      idle: "ignore",
      remove: () => ({ to: "removed", data: {} }),
    },
    running: {
      acquire: "reject",
      started: "ignore",
      startFailed: "ignore",
      touch: "ignore",
      idle: "ignore",
      remove: () => ({ to: "removed", data: {} }),
    },
  },
  release: {
    container: () => ({ _tag: "stopContainer", reason: "released" }),
    sandbox: () => ({ _tag: "dropSandbox" }),
  },
};

export const contracts = [
  Machine.make(LeaseSpec, {
    ...base,
    on: {
      ...base.on,
      // @ts-expect-error a live state must answer every event (here `remove` is missing)
      running: {
        acquire: "reject",
        started: "ignore",
        startFailed: "ignore",
        touch: "ignore",
        idle: "ignore",
      },
    },
  }),
  Machine.make(LeaseSpec, {
    ...base,
    on: {
      ...base.on,
      // @ts-expect-error a terminal state takes no events
      removed: { acquire: "ignore" },
    },
  }),
  Machine.make(LeaseSpec, {
    ...base,
    on: {
      ...base.on,
      cold: {
        ...base.on.cold,
        // @ts-expect-error a transition is synchronous: no I/O inside the transaction
        acquire: async () => ({ to: "cold", data: {} }),
      },
    },
  }),
  Machine.make(LeaseSpec, {
    ...base,
    on: {
      ...base.on,
      cold: {
        ...base.on.cold,
        // @ts-expect-error the target state's data must match its schema
        acquire: () => ({ to: "running", data: { generation: 1 } }),
      },
    },
  }),
  Machine.make(LeaseSpec, {
    ...base,
    on: {
      ...base.on,
      cold: {
        ...base.on.cold,
        // @ts-expect-error no such state
        acquire: () => ({ to: "warm", data: {} }),
      },
    },
  }),
  Machine.make(LeaseSpec, {
    ...base,
    on: {
      ...base.on,
      cold: {
        ...base.on.cold,
        // @ts-expect-error a command's payload must match its schema
        acquire: () => ({ to: "cold", data: {}, commands: [{ _tag: "start", generation: "one" }] }),
      },
    },
  }),
  Machine.make(LeaseSpec, {
    ...base,
    // @ts-expect-error every resource a state holds needs a release
    release: { container: () => ({ _tag: "stopContainer", reason: "released" }) },
  }),
  Machine.make(LeaseSpec, {
    ...base,
    // @ts-expect-error a timer fires an event without payload; `acquire` needs a generation
    timers: { running: (data) => ({ acquire: data.lastActive }) },
  }),
];
