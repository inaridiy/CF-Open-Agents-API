/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { Effect, Exit } from "effect";
import { expect, it } from "vitest";

import {
  InvalidCursor,
  InvalidSessionState,
  RecordTooLarge,
  SessionNotFound,
  type StorageFailure,
  Superseded,
} from "../../packages/agent-api/src/errors.js";
import { kind } from "../../packages/agent-api/src/persistence/kind.js";
import { MemoryStore } from "../../packages/agent-api/src/persistence/memory-store.js";
import { SessionKinds } from "../../packages/agent-api/src/persistence/session-kinds.js";
import type { SessionRecord } from "../../packages/agent-api/src/persistence/session-record.js";
import { makeSessionRepo } from "../../packages/agent-api/src/persistence/session-repo.js";
import { makeSessionTx } from "../../packages/agent-api/src/persistence/session-tx.js";
import type { AgentSession } from "../../packages/agent-api/src/protocol.js";
import type { Execution } from "../../packages/agent-api/src/runtime.js";

/**
 * Policy tests for the seam over the in-memory store. Ordering, pagination and byte
 * budgets are SQLite's semantics and stay in the Durable Object suites.
 */
const session: AgentSession = {
  id: "sess_fixture",
  object: "agent.session",
  agent: {
    id: "agent_fixture",
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
  tenant: "fixture",
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
const execution: Execution = {
  sessionId: session.id,
  turnId: "turn_fixture",
  generation: 1,
  harness: "fixture",
  model: "test",
  agent: { model: "test" },
  input: [],
  checkpoint: null,
  deadline: Date.now() + 60_000,
  sandbox: false,
};
const active: SessionRecord = {
  ...idle,
  generation: 1,
  phase: "running",
  execution,
  session: { ...session, status: "in_progress" },
};
const seeded = (record: SessionRecord = idle) => {
  const store = new MemoryStore();
  store.put(SessionKinds.state, "session", record);
  return store;
};

it("the memory store hands out fresh values, enforces the row budget and rolls back on throw", () => {
  const store = new MemoryStore();
  const counter = kind<{ n: number }>("counter");
  store.put(counter, "a", { n: 1 });
  const first = store.get(counter, "a");
  if (first) first.n = 99;
  expect(store.get(counter, "a")).toEqual({ n: 1 });
  expect(() =>
    store.put(counter, "big", { n: "x".repeat(2_000_000) as unknown as number }),
  ).toThrow(RecordTooLarge);
  expect(() =>
    store.transactionSync(() => {
      store.put(counter, "b", { n: 2 });
      store.append({ type: "agent.session.idle", event_id: "evt_x", session });
      throw new Error("abort");
    }),
  ).toThrow("abort");
  expect(store.get(counter, "b")).toBeUndefined();
  expect(store.lastEvent()).toBe(0);
  expect(store.list(counter, { order: "asc", limit: 10 }).data).toEqual([{ n: 1 }]);
  expect(() => store.list(counter, { order: "asc", limit: 10, after: "nope" })).toThrow(
    InvalidCursor,
  );
  expect(store.list(counter, { order: "asc", limit: 10, after: "a" })).toMatchObject({
    data: [],
    has_more: false,
  });
});

it("the session view migrates on read, guards the phase invariant and fences on identity", () => {
  const legacy = JSON.parse(JSON.stringify(idle)) as Record<string, unknown>;
  delete legacy.schemaVersion;
  const store = seeded(legacy as unknown as SessionRecord);
  const tx = makeSessionTx(store);
  expect(tx.session()?.schemaVersion).toBe(2);
  expect(store.get(SessionKinds.state, "session")?.schemaVersion).toBe(2);
  const impossible = { ...idle, phase: "running", execution: null } as unknown as SessionRecord;
  expect(() => tx.save(impossible)).toThrow(InvalidSessionState);
  expect(() => tx.fenced(execution)).toThrow(Superseded);
  tx.save(active);
  expect(tx.fenced(execution).execution.turnId).toBe(execution.turnId);
  expect(() => tx.fenced({ ...execution, generation: 2 })).toThrow(Superseded);
  tx.save({ ...idle, deleted: true });
  expect(() => tx.requireSession()).toThrow(SessionNotFound);
  expect(() => makeSessionTx(new MemoryStore()).requireSession()).toThrow(SessionNotFound);
});

it("the repository is lazy, keeps domain tags, classifies the rest and rolls back on failure", async () => {
  const store = seeded(active);
  const repo = makeSessionRepo(store, store);
  let runs = 0;
  const program = repo.transaction((tx) => {
    runs++;
    tx.emit({ type: "agent.session.idle", event_id: "evt_1", session });
    return tx.fenced(execution).execution.turnId;
  });
  expect(runs).toBe(0);
  expect(await Effect.runPromise(program)).toBe(execution.turnId);
  expect(runs).toBe(1);
  expect(store.lastEvent()).toBe(1);
  const superseded = await Effect.runPromiseExit(
    repo.transaction((tx) => {
      tx.emit({ type: "agent.session.idle", event_id: "evt_2", session });
      return tx.fenced({ ...execution, turnId: "turn_other" });
    }),
  );
  expect(Exit.isFailure(superseded)).toBe(true);
  if (Exit.isFailure(superseded))
    expect(superseded.cause).toMatchObject({ error: { _tag: "Superseded" } });
  // The typed failure surfaced after the platform rolled the transaction back.
  expect(store.lastEvent()).toBe(1);
  const unknown = await Effect.runPromiseExit(
    repo.read(() => {
      throw new TypeError("not a domain error");
    }),
  );
  expect(Exit.isFailure(unknown)).toBe(true);
  if (Exit.isFailure(unknown)) {
    expect(unknown.cause).toMatchObject({ error: { _tag: "StorageFailure" } });
    const failure = (unknown.cause as { error: StorageFailure }).error;
    expect(failure.cause).toBeInstanceOf(TypeError);
  }
  expect(await Effect.runPromise(repo.read((tx) => tx.commands(10)))).toEqual([]);
});
