import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { explore, gaps, mermaid } from "../src/check.js";
import { Machine } from "../src/index.js";
import { lease } from "./fixture.js";

/**
 * The supervisor job outcome before 101039c: a task that settled while cancellation was
 * requested was recorded as completed. `cancelling` here keeps the bug.
 */
const JobSpec = Machine.spec({
  name: "job",
  facts: Schema.Struct({}),
  events: {
    progress: Schema.Struct({}),
    settled: Schema.Struct({}),
    cancel: Schema.Struct({}),
    fail: Schema.Struct({ code: Schema.String }),
  },
  commands: {},
  states: {
    running: Machine.state(Schema.Struct({})),
    cancelling: Machine.state(Schema.Struct({})),
    completed: Machine.terminal(Schema.Struct({})),
    cancelled: Machine.terminal(Schema.Struct({})),
    failed: Machine.terminal(Schema.Struct({ code: Schema.String })),
  },
});
const job = (settledWhileCancelling: "completed" | "cancelled") =>
  Machine.make(JobSpec, {
    initial: { _tag: "running", data: {} },
    on: {
      running: {
        progress: () => ({ to: "running", data: {} }),
        settled: () => ({ to: "completed", data: {} }),
        cancel: () => ({ to: "cancelling", data: {} }),
        fail: (_data, event) => ({ to: "failed", data: { code: event.code } }),
      },
      cancelling: {
        progress: "ignore",
        settled: () => ({ to: settledWhileCancelling, data: {} }),
        cancel: "ignore",
        fail: (_data, event) => ({ to: "failed", data: { code: event.code } }),
      },
    },
  });
const neverCompletesAfterCancel = (step: Machine.Step<typeof JobSpec>) =>
  step._tag === "Moved" && step.from._tag === "cancelling" && step.to._tag === "completed"
    ? "a cancelled job completed"
    : undefined;

describe("explore", () => {
  it("passes a sound machine and reports what it covered", () => {
    const coverage = explore(lease, { seed: 7 });
    expect(gaps(lease, coverage).states).toEqual([]);
    expect([...coverage.edges.keys()]).toEqual(
      expect.arrayContaining(["cold -> starting", "starting -> running", "running -> cold"]),
    );
  });

  it("finds the cancellation race of 101039c from the initial state", () => {
    expect(() =>
      explore(job("completed"), { from: "initial", seed: 1, invariant: neverCompletesAfterCancel }),
    ).toThrow(/a cancelled job completed/);
    expect(() =>
      explore(job("cancelled"), { from: "initial", seed: 1, invariant: neverCompletesAfterCancel }),
    ).not.toThrow();
  });

  it("finds a transition whose data breaks its schema for some facts", () => {
    const Clock = Machine.spec({
      name: "clock",
      facts: Schema.Struct({ now: Schema.Number.pipe(Schema.int(), Schema.between(0, 100)) }),
      events: { tick: Schema.Struct({}) },
      commands: {},
      states: {
        ticking: Machine.state(
          Schema.Struct({ at: Schema.Number.pipe(Schema.int(), Schema.nonNegative()) }),
        ),
      },
    });
    const clock = Machine.make(Clock, {
      initial: { _tag: "ticking", data: { at: 0 } },
      // Off by ten: negative while the clock reads under ten.
      on: {
        ticking: {
          tick: (_data, _event, facts) => ({ to: "ticking", data: { at: facts.now - 10 } }),
        },
      },
    });
    expect(() => explore(clock, { seed: 3 })).toThrow(/invalid data for ticking/);
  });

  it("draws the explored machine", () => {
    const coverage = explore(lease, { seed: 7 });
    const diagram = mermaid(lease, coverage);
    expect(diagram).toContain("[*] --> cold");
    expect(diagram).toContain("running: running (holds container, sandbox)");
    expect(diagram).toContain("removed --> [*]");
    expect(diagram).toMatch(/starting --> running: started/);
  });
});
