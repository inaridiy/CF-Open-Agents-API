/// <reference types="@cloudflare/vitest-pool-workers/types" />

import {
  abortAllDurableObjects,
  reset,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import OpenAI from "openai";
import type { AgentSession } from "openai/resources/beta/agents/agents";
import { afterEach, expect, it } from "vitest";

import { SessionKinds } from "../../packages/agent-api/src/persistence/session-kinds.js";
import type { SessionRecord } from "../../packages/agent-api/src/session.js";
import type * as WorkerModule from "./worker.js";
import type { SessionDO, TestEnv } from "./worker.js";

declare global {
  namespace Cloudflare {
    interface Env extends TestEnv {}
    interface GlobalProps {
      mainModule: typeof WorkerModule;
    }
  }
}

const tenant = "forker";
const api = new OpenAI({
  apiKey: tenant,
  baseURL: "https://api.test/v1",
  maxRetries: 0,
  fetch: (input, init) => exports.default.fetch(new Request(input, init)),
});
const params = { agent: { model: "test" }, environment: { type: "none" as const } };
const stub = (id: string) => env.SESSIONS.getByName(JSON.stringify([tenant, id]));
const record = (id: string) =>
  runInDurableObject<SessionDO, SessionRecord>(stub(id), (instance) =>
    instance.db.require(SessionKinds.state, "session"),
  );
async function fork(id: string, body: unknown = {}, key?: string, who = tenant) {
  const response = await exports.default.fetch(
    new Request(`https://api.test/cf/v1/sessions/${id}/fork`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${who}`,
        "content-type": "application/json",
        ...(key ? { "Idempotency-Key": key } : {}),
      },
      body: JSON.stringify(body),
    }),
  );
  return {
    status: response.status,
    body: await response.json<AgentSession & { error?: object }>(),
  };
}
async function settle(id: string) {
  await runDurableObjectAlarm(stub(id));
  await expect
    .poll(async () => {
      await runDurableObjectAlarm(stub(id));
      return (await api.beta.agents.sessions.retrieve(id)).status;
    })
    .not.toBe("in_progress");
}
afterEach(() => reset());

it("forks a completed session onto the same harness with its native checkpoint", async () => {
  const source = await api.beta.agents.sessions.create({
    ...params,
    input: "hello",
    metadata: { origin: "source" },
  });
  await settle(source.id);
  const original = await record(source.id);
  expect(original.checkpoint?.native).toContain("checkpoint/");
  const first = await fork(source.id, { metadata: { origin: "fork" } }, "fork-1");
  expect(first.status).toBe(200);
  expect(first.body.id).not.toBe(source.id);
  expect(first.body.metadata).toEqual({ origin: "fork" });
  expect(first.body.status).toBe("idle");
  expect(first.body.agent.id).toBe(source.agent.id);
  const forked = await record(first.body.id);
  expect(forked.checkpoint).toEqual({
    version: 1,
    driver: original.checkpoint?.driver,
    revision: original.checkpoint?.revision,
    native: original.checkpoint?.native,
  });
  expect(forked.inheritedTranscript).toBeUndefined();
  expect(forked.forkedFrom).toEqual({
    sessionId: source.id,
    turnId: (await api.beta.agents.sessions.turns.list(source.id)).data[0]?.id,
  });
  // The fork owns its own history: no items are copied, and the source is unchanged.
  expect((await api.beta.agents.sessions.items.list(first.body.id)).data).toHaveLength(0);
  expect((await api.beta.agents.sessions.retrieve(source.id)).metadata).toEqual({
    origin: "source",
  });
  const retry = await fork(source.id, { metadata: { origin: "fork" } }, "fork-1");
  expect(retry.body.id).toBe(first.body.id);
  const conflict = await fork(source.id, { metadata: { origin: "other" } }, "fork-1");
  expect(conflict.status).toBe(409);
  expect((await api.beta.agents.sessions.list()).data.map((session) => session.id).sort()).toEqual(
    [source.id, first.body.id].sort(),
  );
  // The trusted RPC surface offers the same operation.
  const bound = await env.AGENTS.createSession("default", { ...params, input: "hello" }, "rpc-src");
  await runDurableObjectAlarm(env.SESSIONS.getByName(JSON.stringify(["default", bound.id])));
  await expect
    .poll(async () => {
      await runDurableObjectAlarm(env.SESSIONS.getByName(JSON.stringify(["default", bound.id])));
      return (await env.AGENTS.retrieveSession("default", bound.id)).status;
    })
    .toBe("idle");
  const viaRpc = await env.AGENTS.forkSession("default", bound.id, { metadata: { via: "rpc" } });
  expect(viaRpc.metadata).toEqual({ via: "rpc" });
  expect((await env.AGENTS.listSessions("default")).data).toHaveLength(2);
});

it("carries a transcript when a runtime with fixed tools would need a new tool surface", async () => {
  const source = await api.beta.agents.sessions.create({
    ...params,
    agent: { model: "test-tools" },
    input: "hello",
  });
  await settle(source.id);
  const same = await fork(source.id, { agent: { reasoning: { effort: "high" } } }, "same");
  expect(same.status).toBe(200);
  expect((await record(same.body.id)).checkpoint?.native).toContain("checkpoint/");
  const retooled = await fork(
    source.id,
    {
      agent: {
        tools: [
          {
            type: "function",
            name: "lookup",
            description: "Added after the thread started",
            parameters: { type: "object" },
          },
        ],
      },
    },
    "retooled",
  );
  expect(retooled.status).toBe(200);
  const forked = await record(retooled.body.id);
  expect(forked.checkpoint).toBeNull();
  expect(forked.inheritedTranscript).toContain("User: hello");
});

it("carries a bounded transcript instead of native history when the harness changes", async () => {
  const source = await api.beta.agents.sessions.create({ ...params, input: "hello" });
  await settle(source.id);
  const forked = await fork(source.id, { agent: { model: "test-tools" } }, "cross");
  expect(forked.status).toBe(200);
  expect(forked.body.agent.model).toBe("test-tools");
  expect(forked.body.agent.id).not.toBe(source.agent.id);
  const before = await record(forked.body.id);
  expect(before.driver).toBe("fixture-tools");
  expect(before.checkpoint).toBeNull();
  expect(before.inheritedTranscript).toContain("User: hello");
  expect(before.inheritedTranscript).toContain("Assistant: Fixture output");
  await api.beta.agents.sessions.events.create(forked.body.id, {
    events: [
      {
        type: "agent.session.input.message",
        input: [{ role: "user", content: [{ type: "input_text", text: "continue" }] }],
      },
    ],
  });
  await settle(forked.body.id);
  const turn = (await api.beta.agents.sessions.turns.list(forked.body.id)).data[0];
  expect(turn?.status).toBe("completed");
  const { input } = JSON.parse(await env.SCRIPTED.getByName(turn?.id ?? "").started()) as {
    input: { content: { type: string; text?: string }[] }[];
  };
  // The runtime saw the transcript first and the new request last; the API saw only the request.
  expect(input).toHaveLength(2);
  expect(JSON.stringify(input[0])).toContain("Assistant: Fixture output");
  expect(input[1]?.content[0]).toEqual({ type: "input_text", text: "continue" });
  const items = (await api.beta.agents.sessions.items.list(forked.body.id, { order: "asc" })).data;
  expect(items.filter((item) => item.type === "message" && item.role === "user")).toHaveLength(1);
  await abortAllDurableObjects();
  expect((await record(forked.body.id)).inheritedTranscript).toBeUndefined();
});

it("recovers an indeterminate session by forking and rejects active or foreign sources", async () => {
  const active = await api.beta.agents.sessions.create({ ...params, input: "hold" });
  await runDurableObjectAlarm(stub(active.id));
  expect((await fork(active.id)).status).toBe(409);
  const turn = (await api.beta.agents.sessions.turns.list(active.id)).data[0];
  if (!turn) throw new Error("Missing turn");
  await env.SCRIPTED.getByName(turn.id).vanish();
  await abortAllDurableObjects();
  await expect
    .poll(async () => {
      await runDurableObjectAlarm(stub(active.id));
      return (await api.beta.agents.sessions.retrieve(active.id)).error;
    })
    .toBe("outcome_unknown");
  await expect(
    api.beta.agents.sessions.events.create(active.id, {
      events: [
        {
          type: "agent.session.input.message",
          input: [{ role: "user", content: [{ type: "input_text", text: "again" }] }],
        },
      ],
    }),
  ).rejects.toMatchObject({ status: 409 });
  const recovered = await fork(active.id, {}, "recover");
  expect(recovered.status).toBe(200);
  expect(recovered.body.status).toBe("idle");
  expect((await record(recovered.body.id)).inheritedTranscript).toContain("User: hold");
  expect((await fork(active.id, {}, "foreign", "someone-else")).status).toBe(404);
  expect((await fork(active.id, { agent: { model: "missing" } })).status).toBe(422);
  expect((await fork(active.id, { unexpected: true })).status).toBe(400);
});
