/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { reset, runInDurableObject } from "cloudflare:test";
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
afterEach(async () => {
  await reset();
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

it("interrupted deletion can be retried without breaking tenant listings", async () => {
  const session = await api.beta.agents.sessions.create(params);
  // Stop between the two production DELETE RPC calls to model a lost response.
  await stub(session.id).delete();
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
          description: "x".repeat(800000),
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
