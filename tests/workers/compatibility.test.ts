/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { abortAllDurableObjects, reset, runDurableObjectAlarm } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import OpenAI from "openai";
import type { AgentSessionEvent, InputContentParam } from "openai/resources/beta/agents/agents";
import { afterEach, expect, it } from "vitest";
import type { TestEnv } from "./worker.js";

declare global {
  namespace Cloudflare {
    interface Env extends TestEnv {}
    interface GlobalProps {
      mainModule: typeof import("./worker.js");
    }
  }
}
const api = new OpenAI({
  apiKey: "compat",
  baseURL: "https://api.test/v1",
  maxRetries: 0,
  fetch: (input, init) => exports.default.fetch(new Request(input, init)),
});
const params = { agent: { model: "test" }, environment: { type: "none" as const } };
const stub = (id: string) => env.SESSIONS.getByName(JSON.stringify(["compat", id]));
const image = { type: "input_image" as const, image_url: "data:image/png;base64,iVBORw0KGgo=" };
afterEach(() => reset());

it.each(["object", "content", "failure"])(
  "runs SDK toolHandlers with %s results through durable commands",
  async (kind) => {
    const session = await api.beta.agents.sessions.create({
      ...params,
      agent: {
        model: "test-images",
        tools: [
          {
            type: "function",
            name: "lookup",
            description: "Lookup",
            parameters: { type: "object", properties: { query: { type: "string" } } },
          },
        ],
      },
    });
    let calls = 0;
    const events: AgentSessionEvent[] = [];
    const content: InputContentParam[] = [{ type: "input_text", text: "proof" }, image];
    for await (const event of api.beta.agents.sessions.stream(session.id, {
      input: "compat-tools",
      toolHandlers: {
        lookup: (args) => {
          calls++;
          expect(args).toEqual({ query: "proof" });
          if (kind === "failure") throw new Error("Private handler detail");
          return kind === "object" ? { ok: true } : content;
        },
      },
    }))
      events.push(event);
    expect(calls).toBe(1);
    expect(events.at(-1)?.type).toBe("agent.session.idle");
    const turn = (await api.beta.agents.sessions.turns.list(session.id)).data[0];
    if (!turn) throw new Error("Missing turn");
    const command = await env.SCRIPTED.getByName(turn.id).toolResult();
    expect(command).toMatchObject({
      type: "tool_result",
      callId: "lookup",
      success: kind !== "failure",
      output:
        kind === "object" ? '{"ok":true}' : kind === "content" ? content : "Tool handler failed.",
    });
    await abortAllDurableObjects();
    const result = (await api.beta.agents.sessions.items.list(session.id)).data.find(
      (item) => item.type === "function_call_output",
    );
    expect(result).toMatchObject({
      type: "function_call_output",
      status: kind === "failure" ? "failed" : "completed",
      output: kind === "object" ? '{"ok":true}' : kind === "content" ? content : null,
    });
    expect(JSON.stringify(result)).not.toContain("Private handler detail");
  },
);

it("preserves image input and rejects unsupported image paths before state mutation", async () => {
  await expect(
    api.beta.agents.sessions.create({ ...params, input: [{ role: "user", content: [image] }] }),
  ).rejects.toMatchObject({ status: 422 });
  expect((await api.beta.agents.sessions.list()).data).toHaveLength(0);
  const session = await api.beta.agents.sessions.create({
    ...params,
    agent: { model: "test-images" },
    input: [{ role: "user", content: [image] }],
  });
  await runDurableObjectAlarm(stub(session.id));
  await abortAllDurableObjects();
  const items = await api.beta.agents.sessions.items.list(session.id, { order: "asc" });
  expect(items.data[0]).toMatchObject({ role: "user", content: [image] });
  const plain = await api.beta.agents.sessions.create(params);
  await expect(
    api.beta.agents.sessions.events.create(plain.id, {
      events: [
        { type: "agent.session.input.message", input: [{ role: "user", content: [image] }] },
      ],
    }),
  ).rejects.toMatchObject({ status: 422 });
  expect((await api.beta.agents.sessions.turns.list(plain.id)).data).toHaveLength(0);
  await expect(
    api.beta.agents.sessions.create({
      ...params,
      agent: { model: "test-images" },
      input: [
        { role: "user", content: [{ type: "input_image", image_url: "file:///private.png" }] },
      ],
    }),
  ).rejects.toMatchObject({ status: 400 });
});

it("streams reasoning, commands and search, preserves usage through eviction, and pages SDK items", async () => {
  const session = await api.beta.agents.sessions.create(params);
  for (let run = 1; run <= 2; run++) {
    const events: AgentSessionEvent[] = [];
    for await (const event of api.beta.agents.sessions.stream(session.id, {
      input: "compat-stream",
    }))
      events.push(event);
    expect(
      events.some(
        (event) =>
          event.type === "agent.session.turn.item.added" &&
          event.item.type === "message" &&
          event.item.role === "user" &&
          event.output_index === null,
      ),
    ).toBe(true);
    const reasoning = events.filter((event) =>
      event.type.startsWith("agent.session.turn.reasoning_"),
    );
    expect(reasoning.map((event) => event.type)).toEqual([
      "agent.session.turn.reasoning_summary_part.added",
      "agent.session.turn.reasoning_summary_text.delta",
      "agent.session.turn.reasoning_summary_text.done",
      "agent.session.turn.reasoning_summary_part.done",
    ]);
    expect(
      new Set(reasoning.map((event) => ("item_id" in event ? event.item_id : null))).size,
    ).toBe(1);
    expect(
      events.find((event) => event.type === "agent.output.command_execution_output.delta"),
    ).toMatchObject({ delta: "/workspace/project\n" });
    const terminal = events.find((event) => event.type === "agent.session.turn.completed");
    expect(terminal).toMatchObject({
      usage: { total_tokens: 20 },
      turn: { usage: { total_tokens: 20 } },
    });
    await abortAllDurableObjects();
    expect((await api.beta.agents.sessions.retrieve(session.id)).usage).toEqual({
      input_tokens: 12 * run,
      output_tokens: 8 * run,
      total_tokens: 20 * run,
      input_tokens_details: { cached_tokens: 3 * run },
      output_tokens_details: { reasoning_tokens: 5 * run },
    });
  }
  const items = [];
  for await (const item of api.beta.agents.sessions.items.list(session.id, {
    order: "asc",
    limit: 2,
  }))
    items.push(item);
  expect(items).toHaveLength(10);
  expect(new Set(items.map((item) => item.id)).size).toBe(10);
  expect(items.find((item) => item.type === "command_execution")).toMatchObject({
    cwd: "/workspace/project",
    duration_ms: 7,
    exit_code: 0,
    status: "completed",
  });
  expect(items.find((item) => item.type === "reasoning")).toMatchObject({
    summary: [{ type: "summary_text", text: "Checking the result." }],
    status: "completed",
  });
  expect(items.find((item) => item.type === "web_search_call")).toMatchObject({
    action: { type: "search", query: "fixture" },
  });
});

it("marks partial reasoning and commands incomplete on cancellation and retains spent usage", async () => {
  const session = await api.beta.agents.sessions.create({ ...params, input: "compat-cancel" });
  await runDurableObjectAlarm(stub(session.id));
  await api.beta.agents.sessions.events.create(session.id, {
    events: [{ type: "agent.session.input.cancel" }],
  });
  await expect
    .poll(async () => {
      await runDurableObjectAlarm(stub(session.id));
      return (await api.beta.agents.sessions.retrieve(session.id)).status;
    })
    .toBe("idle");
  const items = (await api.beta.agents.sessions.items.list(session.id)).data;
  expect(items.find((item) => item.type === "reasoning")?.status).toBe("incomplete");
  expect(items.find((item) => item.type === "command_execution")?.status).toBe("incomplete");
  const turn = (await api.beta.agents.sessions.turns.list(session.id)).data[0];
  expect(turn).toMatchObject({ status: "cancelled", usage: { total_tokens: 20 } });
  expect((await api.beta.agents.sessions.retrieve(session.id)).status).toBe("idle");
});
