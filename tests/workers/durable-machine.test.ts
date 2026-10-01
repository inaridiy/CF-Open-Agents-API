/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env, runDurableObjectAlarm } from "cloudflare:test";
import { expect, it } from "vitest";

import { IDLE_MS } from "../../packages/durable-machine/test/fixture.js";

const machines = () => env.MACHINES;

it("keeps state, outbox and alarm in the object's SQLite", async () => {
  const stub = machines().getByName("sqlite-lifecycle");
  const start = Date.now() + 3_600_000;
  await stub.setNow(start);
  expect(await stub.send({ _tag: "acquire", generation: 1 })).toBe("Moved");
  expect(await stub.inspect()).toMatchObject({
    state: { _tag: "running", data: { generation: 1, lastActive: start } },
    epoch: 2,
    log: ["start 1"],
    outbox: 0,
    nextWake: start + IDLE_MS,
  });
  expect(await stub.alarmTime()).toBe(start + IDLE_MS);
  expect(await stub.send({ _tag: "acquire", generation: 2 })).toBe("EventRejected");
  // The idle deadline passes; the alarm releases the container, then the sandbox.
  await stub.setNow(start + IDLE_MS);
  expect(await runDurableObjectAlarm(stub)).toBe(true);
  expect(await stub.inspect()).toMatchObject({
    state: { _tag: "cold" },
    log: ["start 1", "stopContainer released", "dropSandbox"],
    nextWake: null,
  });
  expect(await stub.alarmTime()).toBeNull();
});

it("rolls back the transition, its commands and the host's write together", async () => {
  const stub = machines().getByName("sqlite-rollback");
  expect(await stub.failingWrite()).toBe("rolled back");
  expect(await stub.inspect()).toMatchObject({
    state: { _tag: "cold" },
    host: null,
    outbox: 0,
  });
});
