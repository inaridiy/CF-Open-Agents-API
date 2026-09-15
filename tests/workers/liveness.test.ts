/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { reset, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import OpenAI from "openai";
import { afterEach, expect, it } from "vitest";

import { CatalogKinds } from "../../packages/agent-api/src/catalog.js";
import type { Kind } from "../../packages/agent-api/src/persistence/kind.js";
import { SessionKinds } from "../../packages/agent-api/src/persistence/session-kinds.js";
import { ApiError } from "../../packages/agent-api/src/protocol.js";
import type {
  PromiseRuntimeDriver,
  RuntimeBatch,
  RuntimeDriver,
} from "../../packages/agent-api/src/runtime.js";
import { fromPromiseDriver } from "../../packages/agent-api/src/runtime.js";
import { TRANSCRIPT_LIMIT } from "../../packages/agent-api/src/session.js";
import type * as WorkerModule from "./worker.js";
import type { CatalogDO, SessionDO, TestEnv } from "./worker.js";

declare global {
  namespace Cloudflare {
    interface Env extends TestEnv {}
    interface GlobalProps {
      mainModule: typeof WorkerModule;
    }
  }
}
const tenant = "liveness";
const api = new OpenAI({
  apiKey: tenant,
  baseURL: "https://api.test/v1",
  maxRetries: 0,
  fetch: (input, init) => exports.default.fetch(new Request(input, init)),
});
const params = { agent: { model: "test" }, environment: { type: "none" as const } };
const stub = (id: string) => env.SESSIONS.getByName(JSON.stringify([tenant, id]));
const message = (text: string) => ({
  type: "agent.session.input.message" as const,
  input: [{ role: "user" as const, content: [{ type: "input_text" as const, text }] }],
});
const completed = (text: string): RuntimeBatch => ({
  status: "completed",
  cursor: 1,
  events: [{ seq: 1, event: { type: "text", id: "answer", text, phase: "final_answer" } }],
});
const running: RuntimeBatch = { status: "running", cursor: 0, events: [] };
const checkpoint = { version: 1 as const, driver: "fixture", revision: "test-v1", native: "saved" };
/** A scripted driver whose behavior each test overrides per call. */
function driver(overrides: Partial<PromiseRuntimeDriver>): RuntimeDriver {
  return fromPromiseDriver({
    name: "fixture",
    revision: "test-v1",
    capabilities: { steer: true, functions: true, sandbox: false },
    start: async () => {},
    stop: async () => {},
    control: async () => {},
    poll: async () => completed("done"),
    checkpoint: async () => checkpoint,
    ...overrides,
  });
}
function install(instance: SessionDO, fixture: RuntimeDriver, extra: Record<string, unknown> = {}) {
  Object.defineProperty(instance, "dependencies", {
    value: () => ({
      drivers: { fixture },
      maxTurnMs: 60_000,
      pollIntervalMs: 60_000,
      ...extra,
    }),
  });
}
const storageOf = (instance: SessionDO) =>
  (instance as unknown as { ctx: DurableObjectState }).ctx.storage;
const summary = (instance: SessionDO) => ({
  status: instance.retrieve().status,
  error: instance.retrieve().error,
  turns: instance.turns({ order: "asc", limit: 10 }).data.map((turn) => turn.status),
  commands: instance.db.list(SessionKinds.command, { order: "asc", limit: 10 }).data.length,
  lastEvent: instance.replay(0).at(-1)?.event.type,
});
afterEach(() => reset());

it("re-arms the alarm when a busy reconciler cannot take the permit", async () => {
  const session = await api.beta.agents.sessions.create(params);
  const result = await runInDurableObject<SessionDO, unknown>(
    stub(session.id),
    async (instance) => {
      const polling = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      install(
        instance,
        driver({
          poll: async () => {
            polling.resolve();
            await release.promise;
            return completed("done");
          },
        }),
      );
      await instance.submit([message("hold")], "initial");
      const advancing = instance.alarm();
      await polling.promise;
      // The platform clears a fired alarm before the handler runs. Model that, then let the
      // second alarm find the permit taken by the reconciler still waiting on its poll.
      await storageOf(instance).deleteAlarm();
      await instance.alarm();
      const armed = (await storageOf(instance).getAlarm()) !== null;
      release.resolve();
      await advancing;
      return { armed, status: instance.retrieve().status };
    },
  );
  expect(result).toEqual({ armed: true, status: "idle" });
});

it("a steer the runtime refuses becomes the next turn instead of blocking completion", async () => {
  const session = await api.beta.agents.sessions.create(params);
  const result = await runInDurableObject<SessionDO, unknown>(
    stub(session.id),
    async (instance) => {
      let finished = false;
      const controls: string[] = [];
      install(
        instance,
        driver({
          control: async (_execution, _id, command) => {
            controls.push(command.type);
            if (command.type === "steer" && finished)
              throw new ApiError(409, "command_rejected", "Turn is no longer active");
          },
          poll: async () => (finished ? completed("first answer") : running),
        }),
      );
      await instance.submit([message("first")], "initial");
      await instance.alarm();
      // The native turn finished just before the follow-up arrived: the steer is refused.
      finished = true;
      await instance.submit([message("late follow-up")], "follow-up");
      await instance.alarm();
      const items = instance
        .items({ order: "asc", limit: 10 })
        .data.map((item) => [
          item.turn_id,
          item.type === "message" && item.content[0]?.type === "input_text"
            ? item.content[0].text
            : item.type === "message" && item.content[0]?.type === "output_text"
              ? item.content[0].text
              : item.type,
        ]);
      const afterRejection = summary(instance);
      await instance.alarm();
      return { controls, items, afterRejection, final: summary(instance) };
    },
  );
  const turns = await api.beta.agents.sessions.turns.list(session.id, { order: "asc" });
  expect(turns.data).toHaveLength(2);
  const [first, second] = turns.data;
  expect(result).toMatchObject({
    controls: ["steer"],
    // The refused message left the finished turn and opened the next one.
    items: [
      [first?.id, "first"],
      [first?.id, "first answer"],
      [second?.id, "late follow-up"],
    ],
    afterRejection: { status: "in_progress", turns: ["completed", "queued"], commands: 0 },
    final: { status: "idle", turns: ["completed", "completed"], commands: 0 },
  });
});

it("a refused tool result is dropped and a transient control failure still polls", async () => {
  const session = await api.beta.agents.sessions.create(params);
  const result = await runInDurableObject<SessionDO, unknown>(
    stub(session.id),
    async (instance) => {
      let delivered = false;
      let polls = 0;
      let transientFailures = 0;
      install(
        instance,
        driver({
          control: async (_execution, _id, command) => {
            if (command.type === "steer" && transientFailures === 0) {
              transientFailures++;
              throw new Error("connection reset");
            }
            if (command.type === "tool_result")
              throw new ApiError(409, "command_rejected", "Execution is not waiting for tools");
            delivered = true;
          },
          poll: async () => {
            polls++;
            if (delivered) return completed("after steer");
            return {
              status: "waiting",
              cursor: 1,
              events: [
                {
                  seq: 1,
                  event: {
                    type: "function_call",
                    id: "c",
                    callId: "c",
                    name: "lookup",
                    arguments: {},
                  },
                },
              ],
            };
          },
        }),
      );
      await instance.submit([message("first")], "initial");
      await instance.alarm();
      const turn = instance.turns({ order: "asc", limit: 1 }).data[0];
      if (!turn) throw new Error("Missing turn");
      await instance.submit(
        [
          {
            type: "agent.session.input.tool_result",
            call_id: "c",
            turn_id: turn.id,
            success: true,
            output: "value",
          },
          message("steer while waiting"),
        ],
        "result-and-steer",
      );
      await instance.alarm();
      // The tool result was refused for good; the steer's delivery outcome is unknown, so
      // the reconciler polled anyway and keeps the steer for the next alarm.
      const afterFirstDelivery = { ...summary(instance), polls };
      await instance.alarm();
      return { afterFirstDelivery, final: { ...summary(instance), polls, transientFailures } };
    },
  );
  expect(result).toMatchObject({
    afterFirstDelivery: { status: "in_progress", commands: 1, polls: 2 },
    final: { status: "idle", turns: ["completed"], commands: 0, polls: 3, transientFailures: 1 },
  });
});

it.each([
  ["executor_failed", "idle", "agent.session.idle", true],
  ["request_timeout", "idle", "agent.session.idle", true],
  ["outcome_unknown", "failed", "agent.session.failed", false],
  ["programmatic_execution_uncertain", "failed", "agent.session.failed", false],
] as const)(
  "a turn failing with %s leaves the session %s",
  async (code, status, lastEvent, acceptsInput) => {
    const session = await api.beta.agents.sessions.create(params);
    const result = await runInDurableObject<SessionDO, unknown>(
      stub(session.id),
      async (instance) => {
        install(
          instance,
          driver({
            poll: async () => {
              if (code === "outcome_unknown") return { status: "missing", cursor: 0, events: [] };
              if (code === "request_timeout") return running;
              return { status: "failed", cursor: 0, events: [], error: code };
            },
          }),
        );
        await instance.submit([message("go")], "initial");
        if (code === "request_timeout") {
          await instance.alarm();
          const state = instance.db.require(SessionKinds.state, "session");
          if (state.execution)
            instance.db.put(SessionKinds.state, "session", {
              ...state,
              execution: { ...state.execution, deadline: Date.now() - 1 },
            });
        }
        await instance.alarm();
        const events = instance.replay(0).map(({ event }) => event);
        const sealed = summary(instance);
        const accepted = await instance.submit([message("again")], "again");
        return {
          ...sealed,
          turnError: instance.turns({ order: "asc", limit: 1 }).data[0]?.error,
          accepted: accepted._tag === "Right",
          resumed: instance.retrieve().status,
          // The SDK throws on any event carrying a truthy top-level `error` member.
          topLevelErrors: events.filter((event) => "error" in event && event.error).length,
        };
      },
    );
    expect(result).toMatchObject({
      status,
      error: code,
      lastEvent,
      turnError: { code: code === "request_timeout" ? code : "internal_error", message: code },
      accepted: acceptsInput,
      resumed: acceptsInput ? "in_progress" : status,
      topLevelErrors: 0,
    });
    if (!acceptsInput)
      await expect(
        api.beta.agents.sessions.events.create(session.id, { events: [message("again")] }),
      ).rejects.toMatchObject({ status: 409, code: "session_failed" });
  },
);

it("stops and fails a turn on the first runtime event that names unknown state", async () => {
  const session = await api.beta.agents.sessions.create(params);
  const result = await runInDurableObject<SessionDO, unknown>(
    stub(session.id),
    async (instance) => {
      let stops = 0;
      let polls = 0;
      install(
        instance,
        driver({
          stop: async () => {
            stops++;
          },
          poll: async () => {
            polls++;
            return {
              status: "running",
              cursor: 1,
              events: [
                {
                  seq: 1,
                  event: {
                    type: "subagent_turn",
                    id: "turn_ghost",
                    subagentId: "subagent_ghost",
                    status: "in_progress",
                    startedAt: 1,
                    completedAt: null,
                  },
                },
              ],
            };
          },
        }),
      );
      await instance.submit([message("go")], "initial");
      await instance.alarm();
      await instance.alarm();
      return { ...summary(instance), stops, polls };
    },
  );
  expect(result).toMatchObject({
    status: "idle",
    error: "invalid_runtime_event",
    turns: ["failed"],
    stops: 1,
    polls: 1,
  });
});

it("an unregistered executor fails the turn instead of polling forever", async () => {
  const session = await api.beta.agents.sessions.create(params);
  const result = await runInDurableObject<SessionDO, unknown>(
    stub(session.id),
    async (instance) => {
      await instance.submit([message("go")], "initial");
      Object.defineProperty(instance, "dependencies", {
        value: () => ({ drivers: {}, maxTurnMs: 60_000, pollIntervalMs: 60_000 }),
      });
      await instance.alarm();
      const failed = summary(instance);
      await storageOf(instance).deleteAlarm();
      await instance.alarm();
      return { failed, armedAgain: (await storageOf(instance).getAlarm()) !== null };
    },
  );
  expect(result).toMatchObject({
    failed: { status: "idle", error: "executor_unavailable", turns: ["failed"] },
    armedAgain: false,
  });
});

it.each([
  [
    "typed",
    new ApiError(422, "unsupported_capability", "Refused"),
    "failed",
    "unsupported_capability",
  ],
  ["transient", new Error("container unreachable"), "queued", null],
] as const)("a %s start failure is %s after one alarm", async (_kind, error, turnStatus, code) => {
  const session = await api.beta.agents.sessions.create(params);
  const result = await runInDurableObject<SessionDO, unknown>(
    stub(session.id),
    async (instance) => {
      install(
        instance,
        driver({
          start: async () => {
            throw error;
          },
        }),
      );
      await instance.submit([message("go")], "initial");
      await instance.alarm();
      return summary(instance);
    },
  );
  expect(result).toMatchObject({ turns: [turnStatus], error: code });
});

it("deleting a session purges its object and the catalog's reservation records", async () => {
  const session = await api.beta.agents.sessions.create(params, {
    headers: { "Idempotency-Key": "purge-me" },
  });
  const agent = await api.beta.agents.create(
    { model: "test" },
    { headers: { "Idempotency-Key": "agent-key" } },
  );
  const catalog = env.CATALOG.getByName(tenant);
  const counts = () =>
    runInDurableObject<CatalogDO, Record<string, number>>(catalog, async (instance) =>
      Object.fromEntries(
        (
          [
            CatalogKinds.reservation,
            CatalogKinds.reservationSession,
            CatalogKinds.agentKey,
            CatalogKinds.agentKeyIndex,
            CatalogKinds.session,
          ] as Kind<unknown>[]
        ).map((kind) => [kind, instance.db.list(kind, { order: "asc", limit: 100 }).data.length]),
      ),
    );
  expect(await counts()).toEqual({
    reservation: 1,
    reservation_session: 1,
    agent_key: 1,
    agent_key_index: 1,
    session: 1,
  });
  await api.beta.agents.sessions.delete(session.id);
  await api.beta.agents.delete(agent.id);
  expect(await counts()).toEqual({
    reservation: 0,
    reservation_session: 0,
    agent_key: 0,
    agent_key_index: 0,
    session: 0,
  });
  const purged = await runInDurableObject<SessionDO, unknown>(
    stub(session.id),
    async (instance) => ({
      record: instance.db.get(SessionKinds.state, "session"),
      tombstone: instance.db.get(SessionKinds.tombstone, "tombstone"),
      events: instance.db.events(0).length,
      alarm: await storageOf(instance).getAlarm(),
    }),
  );
  expect(purged).toEqual({
    record: undefined,
    tombstone: { id: session.id },
    events: 0,
    alarm: null,
  });
  // A retry after the catalog forgot the session still answers with the deleted shape.
  expect(await api.beta.agents.sessions.delete(session.id)).toMatchObject({
    id: session.id,
    deleted: true,
  });
  await expect(api.beta.agents.sessions.retrieve(session.id)).rejects.toMatchObject({
    status: 404,
  });
});

it("pages and fork transcripts stay bounded when records are large", async () => {
  const session = await api.beta.agents.sessions.create(params);
  const result = await runInDurableObject<SessionDO, unknown>(
    stub(session.id),
    async (instance) => {
      for (let index = 0; index < 8; index++)
        instance.db.put(SessionKinds.item, `msg_${index}`, {
          id: `msg_${index}`,
          type: "message",
          role: "user",
          turn_id: "turn_x",
          phase: null,
          status: "completed",
          content: [{ type: "input_text", text: `${index}`.padEnd(1_000_000, "x") }],
        });
      const first = instance.items({ order: "asc", limit: 100 });
      const ids: string[] = [];
      let after: string | undefined;
      do {
        const page = instance.items({ order: "asc", limit: 100, after });
        ids.push(...page.data.map((item) => item.id ?? "missing"));
        after = page.has_more ? (page.last_id ?? undefined) : undefined;
      } while (after);
      const source = JSON.parse(instance.forkSource()) as {
        _tag: "Right";
        right: { transcript: string };
      };
      return {
        firstPage: first.data.length,
        firstHasMore: first.has_more,
        ids,
        transcript: source.right.transcript.length,
      };
    },
  );
  expect(result).toMatchObject({ firstPage: 4, firstHasMore: true });
  expect((result as { ids: string[] }).ids).toEqual(
    Array.from({ length: 8 }, (_, index) => `msg_${index}`),
  );
  expect((result as { transcript: number }).transcript).toBeLessThanOrEqual(TRANSCRIPT_LIMIT + 64);
});

it("a creation stream ends after the initial turn, or at once without input", async () => {
  const withInput = await api.beta.agents.sessions.create({
    ...params,
    input: "hello",
    stream: true,
  });
  const types: string[] = [];
  for await (const event of withInput) {
    types.push(event.type);
    if (event.type === "agent.session.created") await runDurableObjectAlarm(stub(event.session.id));
  }
  expect(types[0]).toBe("agent.session.created");
  expect(types.at(-1)).toBe("agent.session.idle");
  expect(types).toContain("agent.session.turn.completed");
  const silent: string[] = [];
  for await (const event of await api.beta.agents.sessions.create({ ...params, stream: true }))
    silent.push(event.type);
  expect(silent).toEqual(["agent.session.created"]);
  // The raw wire carries each event exactly once; the SDK's event-id dedup must not be
  // what hides a duplicate delivery (enqueue can re-enter pull synchronously).
  const raw = await exports.default.fetch(
    new Request("https://api.test/v1/agents/sessions", {
      method: "POST",
      headers: { authorization: `Bearer ${tenant}`, "content-type": "application/json" },
      body: JSON.stringify({ ...params, input: "hello", stream: true }),
    }),
  );
  const body = await raw.text();
  const ids = body.match(/^id: \d+$/gm) ?? [];
  expect(ids.length).toBeGreaterThan(0);
  expect(new Set(ids).size).toBe(ids.length);
});

it("live streams send keepalive comments while a turn is quiet", async () => {
  const session = await api.beta.agents.sessions.create(params);
  const chunk = await runInDurableObject<SessionDO, string>(stub(session.id), async (instance) => {
    install(instance, driver({}), { keepaliveMs: 20 });
    const reader = instance.stream().body?.getReader();
    if (!reader) throw new Error("Missing stream body");
    const text = new TextDecoder().decode((await reader.read()).value);
    await reader.cancel();
    return text;
  });
  expect(chunk).toBe(": keepalive\n\n");
});

it("the HTTP layer authenticates before buffering and follows the OpenAI error envelope", async () => {
  const anonymous = (init: RequestInit & { path: string }) =>
    exports.default.fetch(new Request(`https://api.test${init.path}`, init));
  const unauthenticated = await anonymous({ path: "/v1/agents/sessions", method: "GET" });
  expect(unauthenticated.status).toBe(401);
  expect(await unauthenticated.json()).toMatchObject({
    error: { type: "authentication_error", code: "unauthorized" },
  });
  // An oversized anonymous upload is rejected for its credentials, not buffered first.
  const oversized = await anonymous({
    path: "/v1/files",
    method: "POST",
    body: new Uint8Array(60 * 1024 * 1024),
  });
  expect(oversized.status).toBe(401);
  await expect(api.beta.agents.sessions.retrieve("sess_missing")).rejects.toMatchObject({
    status: 404,
    error: { type: "invalid_request_error" },
  });
  const session = await api.beta.agents.sessions.create(params);
  // A fork needs no body at all.
  const forked = await exports.default.fetch(
    new Request(`https://api.test/cf/v1/sessions/${session.id}/fork`, {
      method: "POST",
      headers: { authorization: `Bearer ${tenant}` },
    }),
  );
  expect(forked.status).toBe(200);
  expect((await forked.json<{ status: string }>()).status).toBe("idle");
});

it("session agents omit tool_search as the SDK's session type does, while saved agents keep it", async () => {
  const tools = [{ type: "tool_search" as const }];
  const agent = await api.beta.agents.create({ model: "test-tools", tools });
  expect(agent.tools).toEqual([{ type: "tool_search" }]);
  expect((await api.beta.agents.retrieve(agent.id)).tools).toEqual([{ type: "tool_search" }]);
  const session = await api.beta.agents.sessions.create({
    environment: { type: "none" },
    agent_id: agent.id,
  });
  expect(session.agent.tools).toEqual([]);
});
