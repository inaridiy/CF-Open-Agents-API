/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { abortAllDurableObjects, reset, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import OpenAI from "openai";
import { afterEach, expect, it } from "vitest";
import type { RuntimeDriver } from "../../packages/agent-api/src/runtime.js";
import { fromPromiseDriver } from "../../packages/agent-api/src/runtime.js";
import type { SessionRecord } from "../../packages/agent-api/src/session.js";
import type { SessionDO, TestEnv } from "./worker.js";

declare global {
  namespace Cloudflare {
    interface Env extends TestEnv {}
    interface GlobalProps {
      mainModule: typeof import("./worker.js");
    }
  }
}
const api = new OpenAI({
  apiKey: "review",
  baseURL: "https://api.test/v1",
  maxRetries: 0,
  fetch: (input, init) => exports.default.fetch(new Request(input, init)),
});
const params = { agent: { model: "test" }, environment: { type: "none" as const } };
const stub = (id: string) => env.SESSIONS.getByName(JSON.stringify(["review", id]));
const message = (text: string) => ({
  type: "agent.session.input.message" as const,
  input: [{ role: "user" as const, content: [{ type: "input_text" as const, text }] }],
});
const reportedUsage = (total: number) => ({
  input_tokens: total - 2,
  output_tokens: 2,
  total_tokens: total,
  input_tokens_details: { cached_tokens: 1 },
  output_tokens_details: { reasoning_tokens: 1 },
});
afterEach(async () => {
  await reset();
});

it("migrates the legacy nullable subagent limit after eviction without losing input", async () => {
  const session = await api.beta.agents.sessions.create(params);
  await stub(session.id).submit([message("preserved legacy input")], "legacy");
  await runInDurableObject<SessionDO, void>(stub(session.id), async (instance) => {
    const record = instance.db.require<SessionRecord>("state", "session");
    const legacy = JSON.parse(JSON.stringify(record));
    delete legacy.schemaVersion;
    legacy.agent.multi_agent = { enabled: false, max_concurrent_subagents: null };
    legacy.execution.agent.multi_agent = { enabled: false, max_concurrent_subagents: null };
    instance.db.put("state", "session", legacy);
  });
  await abortAllDurableObjects();
  expect((await api.beta.agents.sessions.retrieve(session.id)).id).toBe(session.id);
  const restored = await runInDurableObject<SessionDO, SessionRecord>(
    stub(session.id),
    async (instance) => instance.db.require<SessionRecord>("state", "session"),
  );
  expect(restored.schemaVersion).toBe(2);
  expect(restored.agent.multi_agent).toEqual({ enabled: false });
  expect(restored).toMatchObject({
    execution: {
      agent: { multi_agent: { enabled: false } },
      input: [{ content: [{ text: "preserved legacy input" }] }],
    },
  });
});

it("accepted steering is not lost when a poll finishes concurrently", async () => {
  const session = await api.beta.agents.sessions.create(params);
  const result = await runInDurableObject<SessionDO, unknown>(
    stub(session.id),
    async (instance) => {
      let signalPolling!: () => void;
      const polling = new Promise<void>((resolve) => {
        signalPolling = resolve;
      });
      let releasePoll!: () => void;
      const released = new Promise<void>((resolve) => {
        releasePoll = resolve;
      });
      const commands: unknown[] = [];
      const driver: RuntimeDriver = fromPromiseDriver({
        name: "fixture",
        revision: "test-v1",
        capabilities: { steer: true, functions: true, sandbox: false },
        start: async () => {},
        stop: async () => {},
        control: async (_e, _id, command) => {
          commands.push(command);
        },
        poll: async () => {
          signalPolling();
          await released;
          return { status: "completed", cursor: 0, events: [] };
        },
        checkpoint: async () => ({
          version: 1,
          driver: "fixture",
          revision: "test-v1",
          native: "saved",
        }),
      });
      Object.defineProperty(instance, "dependencies", {
        value: () => ({ drivers: { fixture: driver }, maxTurnMs: 900000, pollIntervalMs: 60000 }),
      });
      await instance.submit([message("initial")], "first");
      const advancing = instance.alarm();
      await polling;
      const accepted = await instance.submit([message("important follow-up")], "second");
      releasePoll();
      await advancing;
      return {
        accepted,
        status: instance.retrieve().status,
        commands,
        inputs: instance.items({ order: "asc", limit: 100 }).data,
        pending: instance.db.list("command", { order: "asc", limit: 100 }).data,
      };
    },
  );
  expect(result).toMatchObject({ commands: [{ type: "steer" }] });
});

it("checkpoint recovery does not require a surviving container", async () => {
  const session = await api.beta.agents.sessions.create(params);
  const result = await runInDurableObject<SessionDO, unknown>(
    stub(session.id),
    async (instance) => {
      let saved = false;
      let checkpointCalls = 0;
      const driver: RuntimeDriver = fromPromiseDriver({
        name: "fixture",
        revision: "test-v1",
        capabilities: { steer: true, functions: true, sandbox: false },
        start: async () => {},
        stop: async () => {},
        control: async () => {},
        poll: async () => ({ status: saved ? "missing" : "completed", cursor: 0, events: [] }),
        checkpoint: async () => {
          checkpointCalls++;
          if (!saved) {
            saved = true;
            throw new Error("Injected lost RPC response after checkpoint commit");
          }
          return { version: 1, driver: "fixture", revision: "test-v1", native: "already-durable" };
        },
      });
      Object.defineProperty(instance, "dependencies", {
        value: () => ({ drivers: { fixture: driver }, maxTurnMs: 900000, pollIntervalMs: 60000 }),
      });
      await instance.submit([message("initial")], "first");
      await instance.alarm();
      const firstPhase = instance.db.require<SessionRecord>("state", "session").phase;
      await instance.alarm();
      return {
        firstPhase,
        checkpointCalls,
        status: instance.retrieve().status,
        error: instance.retrieve().error,
      };
    },
  );
  expect(result).toMatchObject({ status: "idle", checkpointCalls: 2 });
});

it("keeps subagent tool results scoped and delays child completion until checkpoint commit", async () => {
  const session = await api.beta.agents.sessions.create(params);
  const result = await runInDurableObject<SessionDO, unknown>(
    stub(session.id),
    async (instance) => {
      let replied = false;
      let snapshots = 0;
      const driver = fromPromiseDriver({
        name: "fixture",
        revision: "test-v1",
        capabilities: { steer: true, functions: true, sandbox: false },
        start: async () => {},
        stop: async () => {},
        control: async (_execution, _id, command) => {
          if (command.type === "tool_result") replied = true;
        },
        poll: async () =>
          replied
            ? {
                status: "completed" as const,
                cursor: 7,
                events: [
                  {
                    seq: 5,
                    event: {
                      type: "subagent_turn" as const,
                      id: "turn_child",
                      subagentId: "subagent_child",
                      status: "completed" as const,
                      startedAt: 1,
                      completedAt: 2,
                    },
                  },
                  {
                    seq: 6,
                    event: {
                      type: "usage" as const,
                      id: "child-usage",
                      turnId: "turn_child",
                      subagentId: "subagent_child",
                      usage: reportedUsage(20),
                    },
                  },
                  {
                    seq: 7,
                    event: { type: "usage" as const, id: "root-usage", usage: reportedUsage(10) },
                  },
                ],
              }
            : {
                status: "waiting" as const,
                cursor: 4,
                events: [
                  {
                    seq: 1,
                    event: {
                      type: "subagent" as const,
                      id: "subagent_child",
                      parentId: null,
                      name: null,
                      instructions: "Child task",
                      status: "active" as const,
                      openedAt: 1,
                    },
                  },
                  {
                    seq: 2,
                    event: {
                      type: "subagent_turn" as const,
                      id: "turn_child",
                      subagentId: "subagent_child",
                      status: "in_progress" as const,
                      startedAt: 1,
                      completedAt: null,
                    },
                  },
                  {
                    seq: 3,
                    event: {
                      type: "function_call" as const,
                      id: "call_child",
                      callId: "call_child",
                      name: "lookup",
                      arguments: {},
                      turnId: "turn_child",
                      subagentId: "subagent_child",
                    },
                  },
                  {
                    seq: 4,
                    event: {
                      type: "usage" as const,
                      id: "child-usage",
                      turnId: "turn_child",
                      subagentId: "subagent_child",
                      usage: reportedUsage(10),
                    },
                  },
                ],
              },
        checkpoint: async () => {
          if (++snapshots === 1) throw new Error("Injected checkpoint interruption");
          return {
            version: 1 as const,
            driver: "fixture",
            revision: "test-v1",
            native: "durable-children",
          };
        },
      });
      Object.defineProperty(instance, "dependencies", {
        value: () => ({ drivers: { fixture: driver }, maxTurnMs: 900000, pollIntervalMs: 60000 }),
      });
      await instance.submit([message("parent")], "parent");
      await instance.alarm();
      await instance.submit(
        [
          {
            type: "agent.session.input.tool_result",
            call_id: "call_child",
            turn_id: "turn_child",
            success: true,
            output: "child-only result",
          },
        ],
        "child-result",
      );
      await instance.alarm();
      const before = instance.subagentTurn("subagent_child", "turn_child");
      await instance.alarm();
      return {
        before,
        after: instance.subagentTurn("subagent_child", "turn_child"),
        rootItems: instance.items({ order: "asc", limit: 100 }).data,
        childItems: instance.subagentItems("subagent_child", { order: "asc", limit: 100 }).data,
        rootTurns: instance.turns({ order: "asc", limit: 100 }).data,
        status: instance.retrieve().status,
        usage: instance.retrieve().usage,
      };
    },
  );
  expect(result).toMatchObject({
    before: { status: "in_progress", completed_at: null, usage: { total_tokens: 20 } },
    after: { status: "completed", completed_at: 2, usage: { total_tokens: 20 } },
    status: "idle",
    usage: { total_tokens: 30 },
    rootTurns: [{ subagent_id: null, usage: { total_tokens: 10 } }],
  });
  const items = result as { rootItems: unknown[]; childItems: unknown[] };
  expect(JSON.stringify(items.rootItems)).not.toContain("child-only result");
  expect(items.childItems).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ type: "function_call_output", output: "child-only result" }),
    ]),
  );
  await abortAllDurableObjects();
  expect((await stub(session.id).subagentTurn("subagent_child", "turn_child")).usage).toEqual(
    reportedUsage(20),
  );
  expect((await api.beta.agents.sessions.retrieve(session.id)).usage?.total_tokens).toBe(30);
});

it("interrupted deletion can be retried without breaking tenant listings", async () => {
  const session = await api.beta.agents.sessions.create(params);
  const other = await api.beta.agents.sessions.create(params);
  // Stop between the two production DELETE RPC calls to model a lost response.
  await stub(session.id).delete();
  // Discovery still lists the deleted session; the page omits it instead of failing.
  const during = await api.beta.agents.sessions.list();
  expect(during.data.map((entry) => entry.id)).toEqual([other.id]);
  const deletion = await api.beta.agents.sessions.delete(session.id).then(
    () => 200,
    (e) => e.status,
  );
  const listing = await api.beta.agents.sessions.list().then(
    () => 200,
    (e) => e.status,
  );
  expect(deletion).toBe(200);
  expect(listing).toBe(200);
});

it("rejects oversized serialized reservations before committing catalog records", async () => {
  const parameters = {
    ...params,
    agent: {
      model: "test",
      tools: [
        {
          type: "function" as const,
          name: "lookup",
          description: "x".repeat(1_000_000),
          parameters: { type: "object" },
        },
      ],
    },
  };
  const body = JSON.stringify(parameters);
  const response = await exports.default.fetch(
    new Request("https://api.test/v1/agents/sessions", {
      method: "POST",
      headers: { authorization: "Bearer review", "content-type": "application/json" },
      body,
    }),
  );
  expect(response.status).toBe(413);
  expect(await response.json()).toMatchObject({ error: { code: "storage_record_too_large" } });
  const records = await runInDurableObject(
    env.CATALOG.getByName("review"),
    async (_instance, state) =>
      state.storage.sql.exec<{ count: number }>("SELECT count(*) AS count FROM records").one()
        .count,
  );
  expect(records).toBe(0);
});

it("oversized UTF-8 state rolls back the complete input transaction", async () => {
  const session = await api.beta.agents.sessions.create(params);
  const result = await runInDurableObject<SessionDO, unknown>(
    stub(session.id),
    async (instance) => {
      const before = instance.db.lastEvent();
      // Each part satisfies the public string limit, but UTF-8 state exceeds the row budget.
      const accepted = await instance.submit(
        [
          {
            type: "agent.session.input.message",
            input: [
              {
                role: "user",
                content: Array.from({ length: 6 }, () => ({
                  type: "input_text" as const,
                  text: "界".repeat(120000),
                })),
              },
            ],
          },
        ],
        "oversized-unicode",
      );
      return {
        accepted,
        before,
        after: instance.db.lastEvent(),
        status: instance.retrieve().status,
        turns: instance.turns({ order: "asc", limit: 100 }).data,
        items: instance.items({ order: "asc", limit: 100 }).data,
        idempotency: instance.db.get("idempotency", "oversized-unicode") ?? null,
      };
    },
  );
  expect(result).toMatchObject({
    accepted: { ok: false, error: { status: 413, code: "storage_record_too_large" } },
    status: "idle",
    turns: [],
    items: [],
    idempotency: null,
  });
  const events = result as { before: number; after: number };
  expect(events.after).toBe(events.before);
});

it.each([
  ["cancelled", "in_progress"],
  ["cancelled", "waiting"],
  ["failed", "in_progress"],
  ["failed", "waiting"],
] as const)(
  "%s root turns terminate %s children that never emitted their own terminal event",
  async (status, childStatus) => {
    const session = await api.beta.agents.sessions.create(params);
    const result = await runInDurableObject<SessionDO, unknown>(
      stub(session.id),
      async (instance) => {
        const driver = fromPromiseDriver({
          name: "fixture",
          revision: "test-v1",
          capabilities: { steer: true, functions: true, sandbox: false },
          start: async () => {},
          stop: async () => {},
          control: async () => {},
          poll: async () => ({
            status,
            cursor: 4,
            events: [
              {
                seq: 1,
                event: {
                  type: "subagent",
                  id: "child",
                  parentId: null,
                  name: null,
                  instructions: "work",
                  status: "active",
                  openedAt: 1,
                },
              },
              {
                seq: 2,
                event: {
                  type: "subagent_turn",
                  id: "child-turn",
                  subagentId: "child",
                  status: childStatus,
                  startedAt: 1,
                  completedAt: null,
                },
              },
              {
                seq: 3,
                event: {
                  type: "reasoning",
                  id: "child-reasoning",
                  turnId: "child-turn",
                  subagentId: "child",
                  summary: ["Still working."],
                  status: "in_progress",
                },
              },
              {
                seq: 4,
                event: {
                  type: "usage",
                  id: "child-usage",
                  turnId: "child-turn",
                  subagentId: "child",
                  usage: reportedUsage(10),
                },
              },
            ],
          }),
          checkpoint: async () => {
            throw new Error("A failed root must not checkpoint");
          },
        });
        Object.defineProperty(instance, "dependencies", {
          value: () => ({ drivers: { fixture: driver }, maxTurnMs: 900000, pollIntervalMs: 60000 }),
        });
        await instance.submit([message("parent")], "terminal-parent");
        await instance.alarm();
        return instance.subagentTurn("child", "child-turn");
      },
    );
    expect(result).toMatchObject({
      status,
      completed_at: expect.any(Number),
      usage: { total_tokens: 10 },
    });
    await abortAllDurableObjects();
    expect(await stub(session.id).subagentTurn("child", "child-turn")).toMatchObject({
      status,
      usage: { total_tokens: 10 },
    });
    expect(
      (await stub(session.id).subagentItems("child", { order: "asc", limit: 10 })).data,
    ).toEqual([expect.objectContaining({ type: "reasoning", status: "incomplete" })]);
    expect((await api.beta.agents.sessions.retrieve(session.id)).usage?.total_tokens).toBe(10);
  },
);

it("direct deletion migrates legacy records and remains idempotent after eviction", async () => {
  const session = await api.beta.agents.sessions.create(params);
  await runInDurableObject<SessionDO, void>(stub(session.id), (instance) => {
    const legacy = JSON.parse(
      JSON.stringify(instance.db.require<SessionRecord>("state", "session")),
    );
    delete legacy.schemaVersion;
    legacy.agent.multi_agent = { enabled: false, max_concurrent_subagents: null };
    instance.db.put("state", "session", legacy);
  });
  await abortAllDurableObjects();
  expect(await stub(session.id).delete()).toMatchObject({ deleted: true });
  expect(await stub(session.id).delete()).toMatchObject({ deleted: true });
});
