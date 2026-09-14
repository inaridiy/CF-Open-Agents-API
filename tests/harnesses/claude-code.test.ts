import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";
import type { Execution, RuntimeBatch, RuntimeEvent } from "../../packages/agent-api/src/index.js";
import { createModelGateway, nativeModel } from "../../packages/agent-api/src/models.js";
import { createSupervisor } from "../../packages/supervisor/src/server.js";
import { serveFetch } from "./http.js";

/** Content blocks a scripted Anthropic Messages reply streams back. */
type Block =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "server_tool_use"; id: string; name: "web_search"; input: unknown }
  | { type: "web_search_tool_result"; tool_use_id: string; content: unknown };
interface Reply {
  blocks?: Block[];
  stop_reason?: "end_turn" | "tool_use";
  /** HTTP error instead of a message. */
  error?: { status: number; type: string; message: string };
}
type Request = Record<string, unknown> & {
  messages: { role: string; content: unknown }[];
  tools?: { name?: string; type?: string }[];
};
const usage = { input_tokens: 17, cache_read_input_tokens: 5, cache_creation_input_tokens: 2 };

/** Real Anthropic Messages SSE fixture behind the private gateway's native passthrough. */
async function anthropicFixture(script: (request: Request, index: number) => Reply) {
  const requests: Request[] = [];
  const sse = (events: { event: string; data: unknown }[]) =>
    events.map(({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
  const upstream = await serveFetch(async (request) => {
    const body = (await request.json()) as Request;
    const reply = script(body, requests.length);
    requests.push(body);
    if (reply.error)
      return Response.json(
        { type: "error", error: { type: reply.error.type, message: reply.error.message } },
        { status: reply.error.status },
      );
    const id = `msg_${requests.length}`;
    const events: { event: string; data: unknown }[] = [
      {
        event: "message_start",
        data: {
          type: "message_start",
          message: {
            id,
            type: "message",
            role: "assistant",
            model: "fixture",
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { ...usage, output_tokens: 1 },
          },
        },
      },
    ];
    for (const [index, block] of (reply.blocks ?? []).entries()) {
      const start = (content_block: unknown) => ({
        event: "content_block_start",
        data: { type: "content_block_start", index, content_block },
      });
      const deltaEvent = (delta: unknown) => ({
        event: "content_block_delta",
        data: { type: "content_block_delta", index, delta },
      });
      if (block.type === "text") {
        events.push(start({ type: "text", text: "" }));
        events.push(deltaEvent({ type: "text_delta", text: block.text }));
      } else if (block.type === "thinking") {
        events.push(start({ type: "thinking", thinking: "", signature: "" }));
        events.push(deltaEvent({ type: "thinking_delta", thinking: block.thinking }));
        events.push(deltaEvent({ type: "signature_delta", signature: "sig" }));
      } else if (block.type === "tool_use" || block.type === "server_tool_use") {
        events.push(start({ type: block.type, id: block.id, name: block.name, input: {} }));
        events.push(
          deltaEvent({ type: "input_json_delta", partial_json: JSON.stringify(block.input) }),
        );
      } else events.push(start(block));
      events.push({ event: "content_block_stop", data: { type: "content_block_stop", index } });
    }
    events.push({
      event: "message_delta",
      data: {
        type: "message_delta",
        delta: { stop_reason: reply.stop_reason ?? "end_turn", stop_sequence: null },
        usage: { output_tokens: 7 },
      },
    });
    events.push({ event: "message_stop", data: { type: "message_stop" } });
    return new Response(sse(events), {
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
    });
  });
  const gateway = createModelGateway(() => ({
    primary: nativeModel({
      protocol: "anthropic",
      baseURL: `${upstream.url}/v1`,
      apiKey: "fixture-key",
      model: "fixture-model",
    }),
  }));
  const model = await serveFetch((request) => gateway.fetch(request, {}));
  return {
    requests,
    url: model.url,
    close: async () => {
      await model.close();
      await upstream.close();
    },
  };
}

const lookup = {
  type: "function" as const,
  name: "lookup",
  description: "Look up a value",
  parameters: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
    additionalProperties: false,
  },
};
const toolName = (request: Request, pattern: RegExp) =>
  request.tools?.find((tool) => tool.name && pattern.test(tool.name))?.name;
const text = (request: Request) => JSON.stringify(request.messages);

async function harness(script: (request: Request, index: number) => Reply) {
  const directory = await mkdtemp(join(tmpdir(), "cf-claude-"));
  const diagnostics: string[] = [];
  const fixture = await anthropicFixture(script);
  let supervisor: ReturnType<typeof createSupervisor> | undefined;
  const server = await serveFetch(async (request) =>
    supervisor ? supervisor.app.fetch(request) : new Response(null, { status: 503 }),
  );
  supervisor = createSupervisor({
    binary: "codex",
    opencodeBinary: resolve("node_modules/.bin/opencode"),
    directory,
    modelBaseUrl: `${fixture.url}/v1`,
    sandboxUrl: "http://unused.invalid",
    supervisorUrl: server.url,
    diagnostics: (line) => diagnostics.push(line),
  });
  const context = () =>
    `${fixture.requests.map((r) => text(r)).join("\n---\n")}\n${diagnostics.join("\n")}`;
  const post = async (path: string, body: unknown) => {
    const response = await fetch(server.url + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const body_ = await response.text();
    return { ok: response.ok, status: response.status, body: body_ };
  };
  const poll = async (turnId: string) =>
    (await (await fetch(`${server.url}/jobs/${turnId}`)).json()) as RuntimeBatch;
  /** Drive the job, answering client function calls with `answer`, until it stops. */
  const finish = async (
    turnId: string,
    answer: (call: Extract<RuntimeEvent, { type: "function_call" }>) => Promise<string> | string,
    options: { allow?: RuntimeBatch["status"][] } = {},
  ) => {
    const answered = new Set<string>();
    for (let attempt = 0; attempt < 600; attempt++) {
      const batch = await poll(turnId);
      for (const { event } of batch.events)
        if (event.type === "function_call" && !answered.has(event.callId)) {
          answered.add(event.callId);
          const result = await post(`/jobs/${turnId}/control`, {
            operationId: `${turnId}:${event.callId}`,
            command: {
              type: "tool_result",
              callId: event.callId,
              success: true,
              output: await answer(event),
            },
          });
          expect(result.ok, `${result.body}\n${context()}`).toBe(true);
        }
      if (["completed", "cancelled", "failed"].includes(batch.status)) {
        if (!(options.allow ?? ["completed"]).includes(batch.status))
          throw new Error(`Unexpected ${batch.status} (${batch.error})\n${context()}`);
        return batch;
      }
      await delay(50);
    }
    throw new Error(`Turn did not finish\n${context()}`);
  };
  const waitFor = async (turnId: string, predicate: (batch: RuntimeBatch) => boolean) => {
    for (let attempt = 0; attempt < 600; attempt++) {
      const batch = await poll(turnId);
      if (predicate(batch)) return batch;
      if (batch.status === "failed") throw new Error(`Failed early: ${batch.error}\n${context()}`);
      await delay(50);
    }
    throw new Error(`Condition not reached\n${context()}`);
  };
  const execution = (overrides: Partial<Execution>): Execution => ({
    sessionId: "sess_claude",
    turnId: "turn_first",
    generation: 1,
    harness: "claude-code",
    model: "primary",
    agent: { model: "primary", tools: [lookup] },
    input: [{ role: "user", content: [{ type: "input_text", text: "Find the durable value." }] }],
    checkpoint: null,
    deadline: Date.now() + 50_000,
    sandbox: false,
    ...overrides,
  });
  return {
    fixture,
    diagnostics,
    context,
    post,
    poll,
    finish,
    waitFor,
    execution,
    close: async () => {
      await supervisor?.stop();
      await server.close();
      await fixture.close();
      // The native process may still be flushing session files while it exits.
      for (let attempt = 0; ; attempt++) {
        try {
          await rm(directory, { recursive: true, force: true });
          break;
        } catch (error) {
          if (attempt >= 20) throw error;
          await delay(100);
        }
      }
    },
  };
}
const events = (batch: RuntimeBatch) => batch.events.map(({ event }) => event);

it("maps reasoning effort, summary display and structured output onto the SDK", async () => {
  const schema = {
    type: "object",
    properties: { answer: { type: "string" } },
    required: ["answer"],
    additionalProperties: false,
  };
  const h = await harness((request) => {
    const structured = toolName(request, /structured/i);
    if (structured && !text(request).includes(structured))
      return {
        blocks: [
          { type: "thinking", thinking: "Weighing the answer." },
          { type: "text", text: "Here is the answer." },
          { type: "tool_use", id: "toolu_1", name: structured, input: { answer: "42" } },
        ],
        stop_reason: "tool_use",
      };
    return { blocks: [{ type: "text", text: "plain" }] };
  });
  try {
    const execution = h.execution({
      agent: {
        model: "primary",
        tools: [lookup],
        reasoning: { effort: "minimal", summary: "concise" },
        text: { format: { type: "json_schema", schema } },
      },
    });
    const start = await h.post("/jobs", { execution, operationId: "start" });
    expect(start.ok, start.body).toBe(true);
    const batch = await h.finish(execution.turnId, () => "unused");
    const first = h.fixture.requests[0];
    expect(first, h.context()).toBeDefined();
    const wire = JSON.stringify(first);
    expect(wire, wire).toContain('"effort":"low"');
    expect(wire, wire).toContain('"display":"summarized"');
    expect(wire, wire).toContain('"type":"adaptive"');
    const finals = events(batch).filter(
      (event) => event.type === "text" && event.phase === "final_answer",
    );
    expect(finals.map((event) => (event.type === "text" ? event.text : ""))).toEqual([
      JSON.stringify({ answer: "42" }),
    ]);
    expect(
      events(batch).some(
        (event) => event.type === "reasoning" && event.summary.join("").includes("Weighing"),
      ),
    ).toBe(true);
  } finally {
    await h.close();
  }
});

it("announces commentary before a tool call and the closing message as the answer", async () => {
  const h = await harness((request, index) => {
    const tool = toolName(request, /function_0$/);
    if (index === 0 && tool)
      return {
        blocks: [
          { type: "text", text: "Let me check." },
          { type: "tool_use", id: "toolu_1", name: tool, input: { query: "durable" } },
        ],
        stop_reason: "tool_use",
      };
    return { blocks: [{ type: "text", text: "Done." }] };
  });
  try {
    const execution = h.execution({});
    await h.post("/jobs", { execution, operationId: "start" });
    const batch = await h.finish(execution.turnId, () => "durable-value");
    const texts = events(batch).flatMap((event) =>
      event.type === "text" ? [[event.text, event.phase]] : [],
    );
    expect(texts, h.context()).toEqual([
      ["Let me check.", "commentary"],
      ["Done.", "final_answer"],
    ]);
    expect(events(batch).filter((event) => event.type === "function_call")).toHaveLength(1);
  } finally {
    await h.close();
  }
});

it("reports usage for a cancelled turn after interrupting the native query", async () => {
  const h = await harness((request) => {
    const tool = toolName(request, /function_0$/);
    return tool
      ? {
          blocks: [{ type: "tool_use", id: "toolu_1", name: tool, input: { query: "durable" } }],
          stop_reason: "tool_use",
        }
      : { blocks: [{ type: "text", text: "unexpected" }] };
  });
  try {
    const execution = h.execution({});
    await h.post("/jobs", { execution, operationId: "start" });
    await h.waitFor(execution.turnId, (batch) => batch.status === "waiting");
    const cancel = await h.post(`/jobs/${execution.turnId}/control`, {
      operationId: "cancel",
      command: { type: "cancel" },
    });
    expect(cancel.status, cancel.body).toBe(204);
    const batch = await h.waitFor(execution.turnId, (batch) => batch.status === "cancelled");
    expect(
      events(batch).find((event) => event.type === "usage"),
      h.context(),
    ).toMatchObject({ usage: { input_tokens: 24 } });
  } finally {
    await h.close();
  }
});

it.each([
  [403, "permission_error", "authentication_error", "forbidden"],
  [400, "invalid_request_error", "invalid_request", "messages: malformed"],
  [404, "not_found_error", "resource_not_found", "model not found"],
] as const)(
  "maps an upstream %d into the public turn error %s",
  async (status, upstreamType, expected, message) => {
    const h = await harness(() => ({ error: { status, type: upstreamType, message } }));
    try {
      const execution = h.execution({});
      await h.post("/jobs", { execution, operationId: "start" });
      const batch = await h.finish(execution.turnId, () => "unused", { allow: ["failed"] });
      expect(batch.error, h.context()).toBe(expected);
    } finally {
      await h.close();
    }
  },
);

it("folds steered input into the running turn", async () => {
  const h = await harness((request, index) => {
    const tool = toolName(request, /function_0$/);
    if (index === 0 && tool)
      return {
        blocks: [{ type: "tool_use", id: "toolu_1", name: tool, input: { query: "durable" } }],
        stop_reason: "tool_use",
      };
    return { blocks: [{ type: "text", text: "Steered and done." }] };
  });
  try {
    const execution = h.execution({});
    await h.post("/jobs", { execution, operationId: "start" });
    await h.waitFor(execution.turnId, (batch) => batch.status === "waiting");
    const steer = await h.post(`/jobs/${execution.turnId}/control`, {
      operationId: "steer",
      command: {
        type: "steer",
        input: [{ role: "user", content: [{ type: "input_text", text: "ALSO_CHECK_MARKER" }] }],
      },
    });
    expect(steer.status, `${steer.body}\n${h.context()}`).toBe(204);
    const batch = await h.finish(execution.turnId, () => "durable-value");
    expect(
      h.fixture.requests.slice(1).some((request) => text(request).includes("ALSO_CHECK_MARKER")),
      h.context(),
    ).toBe(true);
    expect(
      events(batch).some((event) => event.type === "text" && event.text === "Steered and done."),
    ).toBe(true);
    const late = await h.post(`/jobs/${execution.turnId}/control`, {
      operationId: "steer-late",
      command: {
        type: "steer",
        input: [{ role: "user", content: [{ type: "input_text", text: "too late" }] }],
      },
    });
    expect(late.status).toBe(409);
    expect(late.body).toContain("command_rejected");
  } finally {
    await h.close();
  }
});

it("runs Anthropic hosted web search when the agent enables web_search", async () => {
  const h = await harness((request) => {
    // The CLI runs WebSearch as a client tool whose implementation calls the API's
    // hosted search tool in a separate request.
    if (request.tools?.some((tool) => tool.type?.startsWith("web_search")))
      return {
        blocks: [
          {
            type: "server_tool_use",
            id: "srvtoolu_1",
            name: "web_search",
            input: { query: "durable value" },
          },
          {
            type: "web_search_tool_result",
            tool_use_id: "srvtoolu_1",
            content: [
              {
                type: "web_search_result",
                url: "https://example.com/durable",
                title: "Durable",
                encrypted_content: "opaque",
                page_age: null,
              },
            ],
          },
          { type: "text", text: "Durable value found on example.com." },
        ],
      };
    const search = toolName(request, /^WebSearch$/);
    if (search && !text(request).includes("tool_result"))
      return {
        blocks: [
          { type: "tool_use", id: "toolu_ws", name: search, input: { query: "durable value" } },
        ],
        stop_reason: "tool_use",
      };
    return { blocks: [{ type: "text", text: "Found it on example.com." }] };
  });
  try {
    const execution = h.execution({
      agent: {
        model: "primary",
        tools: [lookup, { type: "web_search", allowed_domains: ["example.com"] }],
      },
    });
    await h.post("/jobs", { execution, operationId: "start" });
    const batch = await h.finish(execution.turnId, () => "unused");
    const hosted = h.fixture.requests
      .flatMap((request) => request.tools ?? [])
      .find((tool) => tool.type?.startsWith("web_search"));
    expect(hosted, h.context()).toBeDefined();
    expect(JSON.stringify(hosted)).toContain("example.com");
    const searches = events(batch).filter((event) => event.type === "web_search");
    expect(searches.map((event) => (event.type === "web_search" ? event.status : ""))).toEqual([
      "in_progress",
      "completed",
    ]);
    expect(searches[0]).toMatchObject({ action: { type: "search", query: "durable value" } });
    expect(
      events(batch).some(
        (event) => event.type === "text" && event.text === "Found it on example.com.",
      ),
    ).toBe(true);
  } finally {
    await h.close();
  }
});

it("projects native subagents with scoped tool calls and output", async () => {
  const h = await harness((request) => {
    const agentTool = toolName(request, /^(Task|Agent)$/);
    const tool = toolName(request, /function_0$/);
    // A subagent's first message is the delegated prompt string; the parent's is the array.
    const isChild = typeof request.messages[0]?.content === "string";
    const childAnswered = text(request).includes("child-durable");
    if (isChild && !childAnswered && tool)
      return {
        blocks: [{ type: "tool_use", id: "toolu_c1", name: tool, input: { query: "child" } }],
        stop_reason: "tool_use",
      };
    if (isChild) return { blocks: [{ type: "text", text: "child done" }] };
    if (agentTool && !text(request).includes("tool_result"))
      return {
        blocks: [
          { type: "text", text: "Delegating." },
          {
            type: "tool_use",
            id: "toolu_p1",
            name: agentTool,
            input: { description: "sub task", prompt: "SUBTASK: find the child value" },
          },
        ],
        stop_reason: "tool_use",
      };
    return { blocks: [{ type: "text", text: "parent done" }] };
  });
  try {
    const execution = h.execution({
      agent: { model: "primary", tools: [lookup], multi_agent: { enabled: true } },
      maxConcurrentSubagents: 2,
    });
    await h.post("/jobs", { execution, operationId: "start" });
    const batch = await h.finish(execution.turnId, (call) => {
      expect(call.subagentId, h.context()).toBeDefined();
      return "child-durable";
    });
    const all = events(batch);
    const subagent = all.find((event) => event.type === "subagent");
    expect(subagent, h.context()).toBeDefined();
    if (subagent?.type !== "subagent") throw new Error("unreachable");
    const turns = all.filter((event) => event.type === "subagent_turn");
    expect(turns.map((event) => (event.type === "subagent_turn" ? event.status : ""))).toEqual([
      "in_progress",
      "completed",
    ]);
    const call = all.find((event) => event.type === "function_call");
    expect(call).toMatchObject({ subagentId: subagent.id });
    expect(all.find((event) => event.type === "text" && event.text === "child done")).toMatchObject(
      { subagentId: subagent.id },
    );
    // The CLI wakes the main thread again when a background subagent finishes, so
    // an earlier root answer is commentary; the last root text is the answer.
    const rootTexts = all.filter((event) => event.type === "text" && !("subagentId" in event));
    const last = rootTexts.at(-1);
    expect(last, h.context()).toMatchObject({ text: "parent done", phase: "final_answer" });
    expect(
      rootTexts.filter((event) => event.type === "text" && event.phase === "final_answer"),
    ).toHaveLength(1);
    // The child ran under the deployment-owned agent definition with the parent's tools.
    const childRequest = h.fixture.requests.find(
      (request) => typeof request.messages[0]?.content === "string",
    );
    expect(childRequest, h.context()).toBeDefined();
    expect(JSON.stringify(childRequest?.system)).toContain("delegated subtask");
    expect(toolName(childRequest as Request, /function_0$/)).toBeDefined();
    expect(toolName(childRequest as Request, /^(Task|Agent)$/)).toBeUndefined();
  } finally {
    await h.close();
  }
});

it("fails with internal_error when structured output retries run out", async () => {
  const schema = {
    type: "object",
    properties: { answer: { type: "string" } },
    required: ["answer"],
    additionalProperties: false,
  };
  // The model never calls the structured output tool, so the CLI's retries run out.
  const h = await harness(() => ({ blocks: [{ type: "text", text: "not json" }] }));
  try {
    const execution = h.execution({
      agent: { model: "primary", text: { format: { type: "json_schema", schema } } },
    });
    await h.post("/jobs", { execution, operationId: "start" });
    const batch = await h.finish(execution.turnId, () => "unused", { allow: ["failed"] });
    expect(batch.status, h.context()).toBe("failed");
    expect(batch.error).toBe("internal_error");
    expect(h.diagnostics.join("\n")).toContain("structured output");
    expect(events(batch).some((event) => event.type === "usage")).toBe(true);
  } finally {
    await h.close();
  }
});
