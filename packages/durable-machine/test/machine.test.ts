import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { InvalidTransition, Machine } from "../src/index.js";
import { IDLE_MS, type Lease, LeaseSpec, lease } from "./fixture.js";

const facts = { now: 1000, busy: 0 };
const running: Machine.State<Lease> = {
  _tag: "running",
  data: { generation: 1, lastActive: 1000 },
};

describe("step", () => {
  it("moves, enqueues the transition's commands and enters the new state", () => {
    const step = lease.step(lease.initial, { _tag: "acquire", generation: 3 }, facts);
    expect(step).toMatchObject({
      _tag: "Moved",
      to: { _tag: "starting", data: { generation: 3 } },
      commands: [{ command: { _tag: "start", generation: 3 }, release: false }],
      entered: true,
    });
  });

  it("answers ignore and reject from the table", () => {
    expect(lease.step(running, { _tag: "started" }, facts)._tag).toBe("Ignored");
    expect(lease.step(running, { _tag: "acquire", generation: 2 }, facts)._tag).toBe("Rejected");
  });

  it("releases what the target does not hold, in declaration order, after explicit commands", () => {
    const step = lease.step(running, { _tag: "remove" }, facts);
    expect(step._tag).toBe("Moved");
    if (step._tag !== "Moved") return;
    expect(step.commands.map((planned) => [planned.command._tag, planned.resource])).toEqual([
      ["stopContainer", "container"],
      ["dropSandbox", "sandbox"],
    ]);
  });

  it("keeps resources both states hold", () => {
    const step = lease.step(running, { _tag: "touch" }, { now: 5000, busy: 0 });
    expect(step).toMatchObject({ _tag: "Moved", commands: [], entered: false });
  });

  it("leaves terminal states absorbing", () => {
    const removed: Machine.State<Lease> = { _tag: "removed", data: {} };
    expect(lease.step(removed, { _tag: "acquire", generation: 1 }, facts)._tag).toBe("Ignored");
  });

  it("derives timers from the state alone", () => {
    expect(lease.timers(running)).toEqual([{ event: "idle", at: 1000 + IDLE_MS }]);
    expect(lease.timers(lease.initial)).toEqual([]);
  });

  it("refuses a transition that breaks the schemas or returns a promise", () => {
    const broken = Machine.make(LeaseSpec, {
      initial: { _tag: "cold", data: {} },
      on: {
        cold: {
          acquire: (() => Promise.resolve({ to: "cold", data: {} })) as never,
          started: () => ({ to: "running", data: { generation: 1, lastActive: -5 } }),
          startFailed: () => ({ to: "cold", data: {}, commands: [{ _tag: "nope" } as never] }),
          touch: () => ({ to: "warm" as never, data: {} }),
          idle: "ignore",
          remove: "ignore",
        },
        starting: {
          acquire: "ignore",
          started: "ignore",
          startFailed: "ignore",
          touch: "ignore",
          idle: "ignore",
          remove: "ignore",
        },
        running: {
          acquire: "ignore",
          started: "ignore",
          startFailed: "ignore",
          touch: "ignore",
          idle: "ignore",
          remove: "ignore",
        },
      },
      release: {
        container: () => ({ _tag: "stopContainer", reason: "x" }),
        sandbox: () => ({ _tag: "dropSandbox" }),
      },
    });
    for (const event of [
      { _tag: "acquire", generation: 1 },
      { _tag: "started" },
      { _tag: "startFailed", reason: "x" },
      { _tag: "touch" },
    ] as const)
      expect(() => broken.step(broken.initial, event, facts)).toThrow(InvalidTransition);
  });

  it("checks a table assembled at run time", () => {
    const Tiny = Machine.spec({
      name: "tiny",
      facts: Schema.Struct({}),
      events: { go: Schema.Struct({}) },
      commands: {},
      states: { a: Machine.state(Schema.Struct({})), z: Machine.terminal(Schema.Struct({})) },
    });
    expect(() =>
      Machine.make(Tiny, { initial: { _tag: "a", data: {} }, on: { a: {} } as never }),
    ).toThrow(/does not answer go/);
    expect(() =>
      Machine.make(Tiny, {
        initial: { _tag: "a", data: {} },
        on: { a: { go: "ignore" }, z: { go: "ignore" } } as never,
      }),
    ).toThrow(/terminal state z has a transition table/);
  });

  it("round-trips stored states and commands through their schemas", () => {
    const encoded = lease.encodeState(running);
    expect(lease.decodeState(JSON.parse(JSON.stringify(encoded)))).toEqual(running);
    expect(() => lease.decodeState({ _tag: "running", data: { generation: "x" } })).toThrow(
      /does not decode/,
    );
    const command = lease.encodeCommand({ _tag: "start", generation: 2 });
    expect(lease.decodeCommand(command)).toEqual({ _tag: "start", generation: 2 });
  });
});
