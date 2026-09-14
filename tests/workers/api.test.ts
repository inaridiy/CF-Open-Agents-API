/// <reference types="@cloudflare/vitest-pool-workers/types" />

import {
  abortAllDurableObjects,
  reset,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import OpenAI from "openai";
import { afterEach, expect, it } from "vitest";
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

function client(tenant = "tenant-a") {
  return new OpenAI({
    apiKey: tenant,
    baseURL: "https://api.test/v1",
    maxRetries: 0,
    fetch: (input, init) => exports.default.fetch(new Request(input, init)),
  });
}
const params = { agent: { model: "test" }, environment: { type: "none" as const } };
const stub = (id: string, tenant = "tenant-a") =>
  env.SESSIONS.getByName(JSON.stringify([tenant, id]));
afterEach(async () => {
  await reset();
});

it("the official SDK creates, runs, pages and retrieves a persisted session", async () => {
  const api = client();
  const session = await api.beta.agents.sessions.create({ ...params, input: "hello" });
  await runDurableObjectAlarm(stub(session.id));
  expect((await api.beta.agents.sessions.retrieve(session.id)).status).toBe("idle");
  const items = await api.beta.agents.sessions.items.list(session.id);
  expect(items.data.some((item) => item.type === "message" && item.role === "assistant")).toBe(
    true,
  );
  const turns = await api.beta.agents.sessions.turns.list(session.id);
  expect(turns.data[0]?.status).toBe("completed");
  await abortAllDurableObjects();
  expect((await api.beta.agents.sessions.retrieve(session.id)).status).toBe("idle");
  const persisted = await runInDurableObject<SessionDO, SessionRecord>(
    stub(session.id),
    (instance) => instance.db.require<SessionRecord>("state", "session"),
  );
  expect(persisted.checkpoint?.native).toContain("checkpoint/");
  expect((await api.beta.agents.sessions.list()).data).toHaveLength(1);
});

it("deduplicates session creation and rejects reuse of a key with a different body", async () => {
  const api = client();
  const options = { headers: { "Idempotency-Key": "creation" } };
  const first = await api.beta.agents.sessions.create(params, options);
  const second = await api.beta.agents.sessions.create(params, options);
  expect(second.id).toBe(first.id);
  await expect(
    api.beta.agents.sessions.create({ ...params, metadata: { changed: "yes" } }, options),
  ).rejects.toMatchObject({ status: 409 });
});

it("rolls back all inputs when a later event in the batch fails validation", async () => {
  const api = client();
  const session = await api.beta.agents.sessions.create(params);
  await expect(
    api.beta.agents.sessions.events.create(session.id, {
      events: [
        {
          type: "agent.session.input.message",
          input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
        },
        {
          type: "agent.session.input.tool_result",
          call_id: "missing",
          turn_id: "missing",
          success: true,
          output: "bad",
        },
      ],
    }),
  ).rejects.toMatchObject({
    status: 400,
    code: "invalid_request_error",
    message: expect.stringContaining("Unknown pending tool call: missing"),
  });
  expect((await api.beta.agents.sessions.retrieve(session.id)).status).toBe("idle");
  expect((await api.beta.agents.sessions.turns.list(session.id)).data).toHaveLength(0);
});

it("steers the existing turn and cancels it through the driver", async () => {
  const api = client();
  const session = await api.beta.agents.sessions.create({ ...params, input: "hold" });
  await runDurableObjectAlarm(stub(session.id));
  await api.beta.agents.sessions.events.create(session.id, {
    events: [
      {
        type: "agent.session.input.message",
        input: [{ role: "user", content: [{ type: "input_text", text: "change direction" }] }],
      },
    ],
  });
  expect((await api.beta.agents.sessions.turns.list(session.id)).data).toHaveLength(1);
  await api.beta.agents.sessions.events.create(session.id, {
    events: [{ type: "agent.session.input.cancel" }],
  });
  await runDurableObjectAlarm(stub(session.id));
  await expect
    .poll(async () => {
      await runDurableObjectAlarm(stub(session.id));
      return (await api.beta.agents.sessions.turns.list(session.id)).data[0]?.status;
    })
    .toBe("cancelled");
});

it("never starts a missing acknowledged execution again", async () => {
  const api = client();
  const session = await api.beta.agents.sessions.create({ ...params, input: "hold" });
  await runDurableObjectAlarm(stub(session.id));
  const turn = (await api.beta.agents.sessions.turns.list(session.id)).data[0];
  if (!turn) throw new Error("Missing turn");
  await expect
    .poll(() =>
      runInDurableObject<SessionDO, string>(
        stub(session.id),
        (instance) => instance.db.require<SessionRecord>("state", "session").phase,
      ),
    )
    .toBe("running");
  await env.SCRIPTED.getByName(turn.id).vanish();
  await abortAllDurableObjects();
  await runDurableObjectAlarm(stub(session.id));
  await expect
    .poll(async () => {
      await runDurableObjectAlarm(stub(session.id));
      return (await api.beta.agents.sessions.retrieve(session.id)).error;
    })
    .toBe("outcome_unknown");
});

it("isolates tenants and validates unsupported features before creating state", async () => {
  const session = await client().beta.agents.sessions.create(params);
  await expect(client("tenant-b").beta.agents.sessions.retrieve(session.id)).rejects.toMatchObject({
    status: 404,
  });
  const unsupported = [
    { multi_agent: { enabled: true } },
    { tools: [{ type: "tool_search" as const }] },
    { tools: [{ type: "web_search" as const }] },
    {
      tools: [
        {
          type: "mcp" as const,
          server_label: "docs",
          transport: { type: "http" as const, server_url: "https://mcp.example/mcp" },
        },
      ],
    },
    {
      tools: [
        {
          type: "function" as const,
          name: "later",
          description: "Deferred",
          parameters: { type: "object" },
          defer_loading: true,
        },
      ],
    },
  ];
  for (const agent of unsupported) {
    await expect(
      client().beta.agents.sessions.create({ ...params, agent: { model: "test", ...agent } }),
    ).rejects.toMatchObject({ status: 422, code: "unsupported_capability" });
    await expect(client().beta.agents.create({ model: "test", ...agent })).rejects.toMatchObject({
      status: 422,
      code: "unsupported_capability",
    });
  }
  expect((await client().beta.agents.sessions.list()).data).toHaveLength(1);
  expect((await client().beta.agents.list()).data).toHaveLength(0);
  // Capability flags, not harness names, decide acceptance.
  const capable = await client().beta.agents.sessions.create({
    ...params,
    agent: {
      model: "test-tools",
      tools: [
        { type: "tool_search" },
        {
          type: "mcp",
          server_label: "docs",
          transport: { type: "http", server_url: "https://mcp.example/mcp" },
        },
      ],
    },
    input: "hello",
  });
  await runDurableObjectAlarm(stub(capable.id));
  expect((await client().beta.agents.sessions.retrieve(capable.id)).status).toBe("idle");
});

it("resolves deployment-owned delegation targets when subagents are enabled", async () => {
  const api = client();
  await expect(
    api.beta.agents.sessions.create({
      ...params,
      agent: { model: "test-misconfigured", multi_agent: { enabled: true } },
    }),
  ).rejects.toMatchObject({ status: 503, code: "delegate_unavailable" });
  const plain = await api.beta.agents.sessions.create({
    ...params,
    agent: { model: "test-lead" },
    input: "hello",
  });
  await runDurableObjectAlarm(stub(plain.id));
  const plainTurn = (await api.beta.agents.sessions.turns.list(plain.id)).data[0];
  expect(JSON.parse(await env.SCRIPTED.getByName(plainTurn?.id ?? "").started())).toMatchObject({
    delegates: null,
  });
  const lead = await api.beta.agents.sessions.create({
    ...params,
    agent: { model: "test-lead", multi_agent: { enabled: true, max_concurrent_subagents: 2 } },
    input: "hello",
  });
  expect(lead.agent.multi_agent).toEqual({ enabled: true, max_concurrent_subagents: 2 });
  await runDurableObjectAlarm(stub(lead.id));
  const leadTurn = (await api.beta.agents.sessions.turns.list(lead.id)).data[0];
  expect(JSON.parse(await env.SCRIPTED.getByName(leadTurn?.id ?? "").started())).toMatchObject({
    delegates: [{ alias: "test-tools", harness: "fixture-tools", model: "fixture-model" }],
    maxConcurrentSubagents: 2,
  });
  const capabilities = await (
    await exports.default.fetch(
      new Request("https://api.test/cf/v1/capabilities", {
        headers: { authorization: "Bearer tenant-a" },
      }),
    )
  ).json<{ agents: Record<string, { delegates?: string[] }> }>();
  expect(capabilities.agents["test-lead"]?.delegates).toEqual(["test-tools"]);
});

it("provides durable replay through a separate extension", async () => {
  const session = await client().beta.agents.sessions.create({ ...params, input: "hello" });
  await runDurableObjectAlarm(stub(session.id));
  const response = await exports.default.fetch(
    new Request(`https://api.test/cf/v1/sessions/${session.id}/events?after=0`, {
      headers: { authorization: "Bearer tenant-a" },
    }),
  );
  const events = await response.json<{ seq: number; event: { type: string } }[]>();
  expect(events.some(({ event }) => event.type === "agent.session.turn.completed")).toBe(true);
  expect(events.map(({ seq }) => seq)).toEqual(
    [...events.map(({ seq }) => seq)].sort((a, b) => a - b),
  );
});

it("the official SDK stream helper observes a complete ordered turn", async () => {
  const api = client();
  const session = await api.beta.agents.sessions.create(params);
  const types: string[] = [];
  let text = "";
  for await (const event of api.beta.agents.sessions.stream(session.id, { input: "hello" })) {
    if (event.type === "agent.session.turn.item.added" && event.output_index === null) continue;
    types.push(event.type);
    if (event.type === "agent.session.turn.output_text.delta") text += event.delta;
  }
  expect(text).toBe("Fixture output");
  const ordered = [
    "agent.session.turn.created",
    "agent.session.turn.in_progress",
    "agent.session.turn.item.added",
    "agent.session.turn.content_part.added",
    "agent.session.turn.output_text.delta",
    "agent.session.turn.output_text.done",
    "agent.session.turn.content_part.done",
    "agent.session.turn.item.done",
    "agent.session.turn.completed",
    "agent.session.idle",
  ];
  const indices = ordered.map((type) => types.indexOf(type));
  expect(indices.every((index) => index >= 0)).toBe(true);
  expect(indices).toEqual([...indices].sort((a, b) => a - b));
});

it("rejects malformed JSON as a client error", async () => {
  const response = await exports.default.fetch(
    new Request("https://api.test/v1/agents/sessions", {
      method: "POST",
      headers: { authorization: "Bearer tenant-a", "content-type": "application/json" },
      body: "{",
    }),
  );
  expect(response.status).toBe(400);
});

it("streams a backlog larger than one page without dropping text or closing early", async () => {
  const api = client();
  const session = await api.beta.agents.sessions.create(params);
  let text = "";
  for await (const event of api.beta.agents.sessions.stream(session.id, { input: "many-events" })) {
    if (event.type === "agent.session.turn.output_text.delta") {
      text += event.delta;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  }
  expect(text).toBe("x".repeat(300 * 256));
});

it("keeps output IDs unique across turns when a provider reuses its native IDs", async () => {
  const api = client();
  const session = await api.beta.agents.sessions.create(params);
  for (let i = 0; i < 2; i++) {
    for await (const _event of api.beta.agents.sessions.stream(session.id, { input: "hello" })) {
      /* Drain the turn. */
    }
  }
  const outputs = (await api.beta.agents.sessions.items.list(session.id)).data.filter(
    (item) => item.type === "message" && item.role === "assistant",
  );
  expect(outputs).toHaveLength(2);
  expect(new Set(outputs.map((item) => item.id)).size).toBe(2);
});
