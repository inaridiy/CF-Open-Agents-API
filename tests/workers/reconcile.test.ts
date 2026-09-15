/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { Effect, Layer, Option, TestClock, TestContext } from "effect";
import { expect, it } from "vitest";

import type { StorageFailure } from "../../packages/agent-api/src/errors.js";
import { MemoryStore } from "../../packages/agent-api/src/persistence/memory-store.js";
import { SessionKinds } from "../../packages/agent-api/src/persistence/session-kinds.js";
import type { SessionRecord } from "../../packages/agent-api/src/persistence/session-record.js";
import { makeSessionRepo } from "../../packages/agent-api/src/persistence/session-repo.js";
import { makeSessionTx } from "../../packages/agent-api/src/persistence/session-tx.js";
import { type AgentSession, ApiError } from "../../packages/agent-api/src/protocol.js";
import type { PromiseRuntimeDriver, RuntimeBatch } from "../../packages/agent-api/src/runtime.js";
import { fromPromiseDriver } from "../../packages/agent-api/src/runtime.js";
import { reconcileTick } from "../../packages/agent-api/src/session-reconcile.js";
import { Alarm, Drivers, Repo } from "../../packages/agent-api/src/session-services.js";
import { addInput, begin, enqueue } from "../../packages/agent-api/src/session-state.js";

/**
 * Reconciler policy without a Durable Object: the three services are substituted, the
 * store is in memory and time is the test clock. Ordering, pagination and the platform's
 * alarm stay covered by the workerd liveness suites.
 */
const session: AgentSession = {
  id: "sess_policy",
  object: "agent.session",
  agent: {
    id: "agent_policy",
    instructions: null,
    model: "test",
    name: null,
    multi_agent: { enabled: false, max_concurrent_subagents: null },
    reasoning: { effort: null, summary: null },
    service_tier: "auto",
    text: { format: { type: "text" }, verbosity: "medium" },
    tools: [],
  },
  created_at: 1,
  last_active_at: 1,
  status: "idle",
  error: null,
  required_actions: [],
  metadata: {},
  usage: null,
  vault_ids: [],
  environment: { type: "none" },
};
const idle: SessionRecord = {
  schemaVersion: 2,
  tenant: "policy",
  session,
  agent: { model: "test" },
  driver: "fixture",
  revision: "test-v1",
  model: "test",
  generation: 0,
  checkpoint: null,
  execution: null,
  cursor: 0,
  phase: "idle",
  deleted: false,
};
const config = { maxTurnMs: 60_000, agents: {} };
const completed = (text: string): RuntimeBatch => ({
  status: "completed",
  cursor: 1,
  events: [{ seq: 1, event: { type: "text", id: "out", text, phase: "final_answer" } }],
});
const fixture = (overrides: Partial<PromiseRuntimeDriver> = {}) =>
  fromPromiseDriver({
    name: "fixture",
    revision: "test-v1",
    capabilities: { steer: true, functions: true, sandbox: false },
    start: async () => {},
    stop: async () => {},
    control: async () => {},
    poll: async () => completed("done"),
    checkpoint: async () => ({ version: 1, driver: "fixture", revision: "test-v1", native: "x" }),
    ...overrides,
  });
/** A store holding one session whose first turn is starting, exactly as `submit` leaves it. */
function starting() {
  const store = new MemoryStore();
  const tx = makeSessionTx(store);
  const input = [{ role: "user" as const, content: [{ type: "input_text" as const, text: "go" }] }];
  store.transactionSync(() => {
    const started = begin(tx, config, idle, input);
    addInput(tx, started, input);
    tx.save(started);
  });
  return { store, tx };
}
function harness(store: MemoryStore, drivers: Record<string, ReturnType<typeof fixture>>) {
  const armed: number[] = [];
  const layer = Layer.mergeAll(
    Layer.succeed(Repo, makeSessionRepo(store, store)),
    Layer.succeed(Alarm, {
      arm: (inMs: number) =>
        Effect.sync((): void => {
          armed.push(inMs);
        }) as Effect.Effect<void, StorageFailure>,
      clear: Effect.void,
    }),
    Layer.succeed(Drivers, {
      get: (name: string) => Option.fromNullable(drivers[name]),
      agents: {},
      maxTurnMs: config.maxTurnMs,
      pollIntervalMs: 250,
      keepaliveMs: 15_000,
    }),
    TestContext.TestContext,
  );
  const run = <A, E>(program: Effect.Effect<A, E, Alarm | Drivers | Repo>) =>
    Effect.runPromise(program.pipe(Effect.provide(layer)));
  return { armed, run };
}
const summary = (store: MemoryStore) => {
  const tx = makeSessionTx(store);
  const record = tx.session();
  return {
    phase: record?.phase,
    status: record?.session.status,
    error: record?.session.error,
    turns: store
      .list(SessionKinds.turn, { order: "asc", limit: 10 })
      .data.map((turn) => turn.status),
    checkpoint: record?.checkpoint?.native ?? null,
    lastEvent: store.events(0).at(-1)?.event.type,
  };
};

it("one tick starts, polls, commits the checkpoint and re-arms the alarm first", async () => {
  const { store } = starting();
  const calls: string[] = [];
  const driver = fixture({
    start: async () => {
      calls.push("start");
    },
    poll: async () => {
      calls.push("poll");
      return completed("answer");
    },
    checkpoint: async () => {
      calls.push("checkpoint");
      return { version: 1, driver: "fixture", revision: "test-v1", native: "saved" };
    },
  });
  const { armed, run } = harness(store, { fixture: driver });
  await run(reconcileTick());
  expect(calls).toEqual(["start", "poll", "checkpoint"]);
  expect(armed).toEqual([250]);
  expect(summary(store)).toEqual({
    phase: "idle",
    status: "idle",
    error: null,
    turns: ["completed"],
    checkpoint: "saved",
    lastEvent: "agent.session.idle",
  });
});

it("a fence that no longer holds ends the tick silently after the I/O it was waiting on", async () => {
  const { store, tx } = starting();
  const driver = fixture({
    poll: async () => {
      // Another writer moved the record on while the poll was in flight.
      store.transactionSync(() => {
        const record = tx.requireSession();
        tx.save({ ...record, execution: null, phase: "idle" });
      });
      return completed("stale");
    },
    checkpoint: async () => {
      throw new Error("Must not checkpoint a superseded turn");
    },
  });
  const { run } = harness(store, { fixture: driver });
  await run(reconcileTick());
  expect(summary(store)).toMatchObject({ phase: "idle", turns: ["in_progress"], checkpoint: null });
});

it("the deadline comes from the clock: an expired turn is stopped and fails with request_timeout", async () => {
  const { store, tx } = starting();
  // `begin` stamps the deadline from the wall clock; pin it to the test clock's timeline.
  store.transactionSync(() => {
    const record = tx.requireSession();
    if (record.execution)
      tx.save({ ...record, execution: { ...record.execution, deadline: config.maxTurnMs } });
  });
  let stops = 0;
  const driver = fixture({
    poll: async () => ({ status: "running", cursor: 0, events: [] }),
    stop: async () => {
      stops++;
    },
  });
  const { run } = harness(store, { fixture: driver });
  await run(reconcileTick());
  expect(summary(store)).toMatchObject({ phase: "running", turns: ["in_progress"] });
  await run(TestClock.adjust(config.maxTurnMs + 1).pipe(Effect.zipRight(reconcileTick())));
  expect({ ...summary(store), stops }).toMatchObject({
    phase: "idle",
    status: "idle",
    error: "request_timeout",
    turns: ["failed"],
    stops: 1,
  });
});

it("an unregistered executor fails the turn without a driver to stop", async () => {
  const { store } = starting();
  const { armed, run } = harness(store, {});
  await run(reconcileTick());
  expect(armed).toEqual([250]);
  expect(summary(store)).toMatchObject({
    phase: "idle",
    error: "executor_unavailable",
    turns: ["failed"],
  });
});

/** A steer queued for the active turn, exactly as `submit` leaves it. */
function queueSteer(store: MemoryStore) {
  const tx = makeSessionTx(store);
  const input = [
    { role: "user" as const, content: [{ type: "input_text" as const, text: "more" }] },
  ];
  store.transactionSync(() => {
    const record = tx.fenced(
      tx.requireSession().execution as NonNullable<SessionRecord["execution"]>,
    );
    enqueue(tx, record, { type: "steer", input }, addInput(tx, record, input));
  });
}
const queued = (store: MemoryStore) =>
  store.list(SessionKinds.command, { order: "asc", limit: 10 }).data.length;

it.each([
  ["CommandRejected", new ApiError(409, "command_rejected", "Turn is no longer active")],
  ["ExecutionMissing", new ApiError(404, "execution_missing", "No such job")],
] as const)(
  "a definite %s drops the command: the steer becomes the next turn and the tick completes",
  async (_tag, answer) => {
    const { store } = starting();
    queueSteer(store);
    const driver = fixture({
      control: async () => {
        throw answer;
      },
    });
    const { run } = harness(store, { fixture: driver });
    await run(reconcileTick());
    expect({ ...summary(store), queued: queued(store) }).toMatchObject({
      queued: 0,
      status: "in_progress",
      turns: ["completed", "queued"],
      checkpoint: "x",
    });
  },
);

it("a TransportFailure keeps the command for the next tick instead of dropping it", async () => {
  const { store } = starting();
  queueSteer(store);
  let reachable = false;
  const delivered: string[] = [];
  const driver = fixture({
    control: async (_execution, _id, command) => {
      if (!reachable) throw new Error("connection reset");
      delivered.push(command.type);
    },
    poll: async () => ({ status: "running", cursor: 0, events: [] }),
  });
  const { run } = harness(store, { fixture: driver });
  await run(reconcileTick());
  expect({ ...summary(store), queued: queued(store), delivered }).toMatchObject({
    queued: 1,
    delivered: [],
    phase: "running",
    turns: ["in_progress"],
  });
  reachable = true;
  await run(reconcileTick());
  expect({ queued: queued(store), delivered }).toEqual({ queued: 0, delivered: ["steer"] });
});
