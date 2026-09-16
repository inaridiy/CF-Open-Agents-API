/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { reset, runDurableObjectAlarm } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, expect, it } from "vitest";

import { agentClient } from "../../examples/caller/src/index.js";
import type {
  AgentSession,
  AgentSessionItem,
  Turn,
} from "../../packages/agent-api/src/protocol.js";

afterEach(async () => {
  await reset();
});
const parameters = {
  agent: { model: "test" },
  environment: { type: "none" as const },
  input: "hello",
};
const stub = (id: string) => env.SESSIONS.getByName(JSON.stringify(["default", id]));
const request = (path: string, init?: RequestInit) =>
  exports.CallerWorker.fetch(
    new Request(`https://caller.test${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${env.API_TOKEN}`,
        "content-type": "application/json",
        "Idempotency-Key": "binding-guide-task",
      },
    }),
  );

it.each(["sdk", "rpc"])(
  "the %s caller creates, retrieves results and deletes across the Service Binding",
  async (mode) => {
    const input = { method: "POST", body: JSON.stringify(parameters) };
    const created = await request(`/${mode}/sessions`, input);
    expect(created.status).toBe(202);
    const session = await created.json<AgentSession>();
    const repeated = await request(`/${mode === "sdk" ? "rpc" : "sdk"}/sessions`, input);
    expect((await repeated.json<AgentSession>()).id).toBe(session.id);
    await runDurableObjectAlarm(stub(session.id));
    const response = await request(`/${mode}/sessions/${session.id}`);
    expect(response.status).toBe(200);
    const result = await response.json<{
      session: AgentSession;
      items: { data: AgentSessionItem[] };
      turns: { data: Turn[] };
    }>();
    expect(result.session.status).toBe("idle");
    expect(
      result.items.data.some(
        (item) =>
          item.type === "message" &&
          item.role === "assistant" &&
          JSON.stringify(item.content).includes("Fixture output"),
      ),
    ).toBe(true);
    expect(result.turns.data[0]?.status).toBe("completed");
    const turn = result.turns.data[0];
    if (!turn) throw new Error("Missing completed turn");
    expect(await env.AGENTS.retrieveTurn("default", session.id, turn.id)).toEqual(turn);
    expect((await env.AGENTS.listSessions("default")).data.map(({ id }) => id)).toContain(
      session.id,
    );
    expect((await request(`/${mode}/sessions/${session.id}`, { method: "DELETE" })).status).toBe(
      200,
    );
    expect((await env.AGENTS.listSessions("default")).data).toHaveLength(0);
  },
);

it("the official SDK streams an entire turn through Service Binding fetch", async () => {
  const client = agentClient(env);
  const session = await client.beta.agents.sessions.create({ ...parameters, input: undefined });
  let text = "";
  let completed = false;
  for await (const event of client.beta.agents.sessions.stream(session.id, {
    input: "hello",
    idempotencyKey: "stream-guide-task",
  })) {
    if (event.type === "agent.session.turn.output_text.delta") text += event.delta;
    if (event.type === "agent.session.turn.completed") completed = true;
  }
  expect(completed).toBe(true);
  expect(text).toBe("Fixture output");
});

it("binding HTTP preserves authentication and RPC preserves tenant and page validation", async () => {
  expect(
    (await exports.CallerWorker.fetch(new Request("https://caller.test/sdk/sessions"))).status,
  ).toBe(401);
  await expect(
    agentClient({ AGENTS: env.AGENTS, API_TOKEN: "wrong" }).beta.agents.sessions.list(),
  ).rejects.toMatchObject({ status: 401 });
  const session = await env.AGENTS.createSession("default", parameters);
  await runDurableObjectAlarm(stub(session.id));
  const turn = (await env.AGENTS.listTurns("default", session.id)).data[0];
  if (!turn) throw new Error("Missing turn");
  for (const operation of [
    () => env.AGENTS.listItems("another-tenant", session.id),
    () => env.AGENTS.listTurns("another-tenant", session.id),
    () => env.AGENTS.retrieveTurn("another-tenant", session.id, turn.id),
    () => env.AGENTS.deleteSession("another-tenant", session.id),
  ])
    await expect(Promise.resolve(operation())).rejects.toMatchObject({
      name: "AgentApiError:404:not_found",
    });
  await expect(
    Promise.resolve(env.AGENTS.listItems("default", session.id, { limit: 0 })),
  ).rejects.toMatchObject({ name: "AgentApiError:400:invalid_request" });
  await expect(
    Promise.resolve(env.AGENTS.listTurns("default", session.id, { limit: 101 })),
  ).rejects.toMatchObject({ name: "AgentApiError:400:invalid_request" });
  expect((await env.AGENTS.listItems("default", session.id, { limit: 1 })).data).toHaveLength(1);
});
