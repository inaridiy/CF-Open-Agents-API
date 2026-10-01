import { expect, it } from "vitest";

import { containerLease } from "../../packages/agent-api/src/containers/lease.js";
import { explore, gaps, mermaid } from "../../packages/durable-machine/src/check.js";

/**
 * The container lifecycle both container objects run, checked over random event sequences
 * from every state: the properties that the 0.5 lifecycle bugs broke.
 */
it("never boots for a deleted session, and destroys the container on every way out", () => {
  const coverage = explore(containerLease, {
    seed: 11,
    runs: 500,
    invariant: (step, event, facts) => {
      if (step._tag !== "Moved") return;
      const boots = step.commands.filter((planned) => planned.command._tag === "boot").length;
      const destroys = step.commands.filter((planned) => planned.command._tag === "destroy").length;
      if (step.to._tag === "retired" && boots > 0) return "a retired lease booted a container";
      if (step.from._tag === "running" && step.to._tag !== "running" && destroys !== 1)
        return `${event._tag} left the running state without destroying the container`;
      if (step.to._tag !== "running" && boots > 0) return "a boot outside the running state";
      if (facts.bootPending && step.from._tag === "running" && boots > 0)
        return "a second boot queued behind one still pending";
      if (step.to._tag === "running" && destroys > 0)
        return "a running lease destroyed its container";
      return;
    },
  });
  expect(gaps(containerLease, coverage).states).toEqual([]);
  expect([...coverage.edges.keys()].sort()).toEqual([
    "running -> retired",
    "running -> stopped",
    "stopped -> retired",
    "stopped -> running",
  ]);
});

it("keeps a busy container past its idle deadline, and ends an idle one", () => {
  const running = {
    _tag: "running" as const,
    data: { since: 0, lastActive: 0, idleMs: 60_000 },
  };
  const at = (now: number, busy = 0) => ({ now, busy, containerRunning: true, bootPending: false });
  expect(containerLease.step(running, { _tag: "idle" }, at(60_000, 1))).toMatchObject({
    _tag: "Moved",
    to: { _tag: "running", data: { lastActive: 60_000 } },
  });
  expect(containerLease.step(running, { _tag: "idle" }, at(59_999))).toMatchObject({
    to: { _tag: "running", data: { lastActive: 0 } },
  });
  expect(containerLease.step(running, { _tag: "idle" }, at(60_000))).toMatchObject({
    to: { _tag: "stopped" },
    commands: [{ command: { _tag: "destroy" }, release: true }],
  });
  // A container the platform stopped is booted again rather than trusted.
  expect(
    containerLease.step(
      running,
      { _tag: "need", idleMs: 60_000 },
      { ...at(5), containerRunning: false },
    ),
  ).toMatchObject({ to: { _tag: "running" }, commands: [{ command: { _tag: "boot" } }] });
  // ...unless a boot is already queued: requests that arrive meanwhile do not pile up boots.
  expect(
    containerLease.step(
      running,
      { _tag: "need", idleMs: 60_000 },
      { ...at(5), containerRunning: false, bootPending: true },
    ),
  ).toMatchObject({ to: { _tag: "running" }, commands: [] });
  expect(containerLease.timers(running)).toEqual([{ event: "idle", at: 60_000 }]);
});

it("draws the lifecycle", () => {
  const diagram = mermaid(containerLease, explore(containerLease, { seed: 11 }));
  expect(diagram).toContain("running: running (holds container)");
  expect(diagram).toContain("retired --> [*]");
});
