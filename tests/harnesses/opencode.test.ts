import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";
import type { Execution, RuntimeBatch, RuntimeEvent } from "../../packages/agent-api/src/index.js";
import { createSupervisor } from "../../packages/supervisor/src/server.js";
import { serveFetch } from "./http.js";

/** One scripted chat-completions reply; the fixture serializes it as OpenAI SSE. */
interface Reply {
  text?: string;
  reasoning?: string;
  toolCalls?: { name: string; args: Record<string, unknown> }[];
  /** HTTP failure instead of a stream. */
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  usage?: { prompt: number; completion: number; cached?: number; reasoning?: number };
  /** Hold the stream open until released (steering tests). */
  hold?: Promise<void>;
}
interface ChatRequest {
  messages: { role: string; content: unknown; tool_calls?: unknown }[];
  tools?: { function: { name: string } }[];
  body: Record<string, unknown>;
}
type Script = (request: ChatRequest, index: number) => Reply | Promise<Reply>;

function sse(chunks: unknown[]): string {
  return `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
}
/** A raw OpenAI-compatible chat endpoint, so OpenCode's own provider code is exercised. */
async function chatFixture(script: Script) {
  const requests: ChatRequest[] = [];
  const server = await serveFetch(async (request) => {
    if (!new URL(request.url).pathname.endsWith("/chat/completions"))
      return new Response("not found", { status: 404 });
    const body = (await request.json()) as ChatRequest["body"];
    const parsed: ChatRequest = {
      messages: (body.messages as ChatRequest["messages"]) ?? [],
      tools: body.tools as ChatRequest["tools"],
      body,
    };
    requests.push(parsed);
    const reply = await script(parsed, requests.length - 1);
    if (reply.status)
      return Response.json(reply.body ?? { error: { message: "scripted failure" } }, {
        status: reply.status,
        headers: reply.headers ?? {},
      });
    const id = `chatcmpl_${requests.length}`;
    const base = { id, object: "chat.completion.chunk", created: 1, model: "scripted" };
    const chunks: unknown[] = [{ ...base, choices: [{ index: 0, delta: { role: "assistant" } }] }];
    if (reply.reasoning)
      chunks.push({
        ...base,
        choices: [{ index: 0, delta: { reasoning_content: reply.reasoning } }],
      });
    if (reply.text)
      for (const piece of reply.text.match(/.{1,12}/gs) ?? [])
        chunks.push({ ...base, choices: [{ index: 0, delta: { content: piece } }] });
    if (reply.toolCalls?.length)
      chunks.push({
        ...base,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: reply.toolCalls.map((call, index) => ({
                index,
                id: `call_${requests.length}_${index}`,
                type: "function",
                function: { name: call.name, arguments: JSON.stringify(call.args) },
              })),
            },
          },
        ],
      });
    const usage = reply.usage ?? { prompt: 10, completion: 5 };
    chunks.push({
      ...base,
      choices: [
        { index: 0, delta: {}, finish_reason: reply.toolCalls?.length ? "tool_calls" : "stop" },
      ],
      usage: {
        prompt_tokens: usage.prompt,
        completion_tokens: usage.completion,
        total_tokens: usage.prompt + usage.completion,
        prompt_tokens_details: { cached_tokens: usage.cached ?? 0 },
        completion_tokens_details: { reasoning_tokens: usage.reasoning ?? 0 },
      },
    });
    if (reply.hold) {
      const head = sse(chunks.slice(0, 1)).replace("data: [DONE]\n\n", "");
      const tail = sse(chunks.slice(1));
      const hold = reply.hold;
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(new TextEncoder().encode(head));
          await hold;
          controller.enqueue(new TextEncoder().encode(tail));
          controller.close();
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    }
    return new Response(sse(chunks), { headers: { "content-type": "text/event-stream" } });
  });
  return { ...server, requests };
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
async function harness(modelUrl: string) {
  const root = await mkdtemp(join(tmpdir(), "cf-opencode-"));
  const directory = join(root, "harness");
  await mkdir(directory);
  const diagnostics: string[] = [];
  let supervisor: ReturnType<typeof createSupervisor> | undefined;
  const server = await serveFetch(async (request) =>
    supervisor ? supervisor.app.fetch(request) : new Response(null, { status: 503 }),
  );
  supervisor = createSupervisor({
    binary: "codex",
    directory,
    modelBaseUrl: `${modelUrl}/v1`,
    sandboxUrl: "http://unused.invalid",
    supervisorUrl: server.url,
    opencodeBinary: resolve("node_modules/.bin/opencode"),
    diagnostics: (line: string) => diagnostics.push(line),
  });
  const post = async (path: string, body: unknown) => {
    const response = await fetch(server.url + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return response;
  };
  const poll = async (turnId: string) =>
    (await (await fetch(`${server.url}/jobs/${turnId}`)).json()) as RuntimeBatch;
  const untilStatus = async (turnId: string, statuses: RuntimeBatch["status"][], ms = 40_000) => {
    const started = Date.now();
    for (;;) {
      const batch = await poll(turnId);
      if (statuses.includes(batch.status)) return batch;
      if (Date.now() - started > ms)
        throw new Error(
          `Timed out waiting for ${statuses.join("/")}: ${JSON.stringify(batch)}\n${diagnostics.join("\n")}`,
        );
      await delay(50);
    }
  };
  return {
    diagnostics,
    post,
    poll,
    untilStatus,
    close: async () => {
      await supervisor?.stop();
      await server.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
function execution(
  overrides: Partial<Execution> & { agent?: Partial<Execution["agent"]> },
): Execution {
  return {
    sessionId: "sess_opencode",
    turnId: "turn_first",
    generation: 1,
    harness: "opencode",
    model: "primary",
    input: [{ role: "user", content: [{ type: "input_text", text: "Start." }] }],
    checkpoint: null,
    deadline: Date.now() + 50_000,
    sandbox: false,
    ...overrides,
    agent: { model: "primary", tools: [lookup], ...overrides.agent },
  };
}
const events = (batch: RuntimeBatch) => batch.events.map(({ event }) => event);
const ofType = <T extends RuntimeEvent["type"]>(batch: RuntimeBatch, type: T) =>
  events(batch).filter((event): event is Extract<RuntimeEvent, { type: T }> => event.type === type);
const textOf = (request: ChatRequest) => JSON.stringify(request.messages);

const jsonSchema = {
  type: "json_schema" as const,
  schema: {
    type: "object",
    properties: { answer: { type: "string" }, confidence: { type: "number" } },
    required: ["answer", "confidence"],
    additionalProperties: false,
  },
};
const toolNames = (request: ChatRequest) => request.tools?.map((tool) => tool.function.name) ?? [];

it("structured output returns the validated object as the final answer", async () => {
  // OpenCode delivers json_schema output through a forced StructuredOutput tool call.
  const model = await chatFixture((request) =>
    toolNames(request).includes("StructuredOutput")
      ? {
          text: "Here is the answer.",
          toolCalls: [{ name: "StructuredOutput", args: { answer: "forty-two", confidence: 0.9 } }],
        }
      : { text: "no structured tool offered" },
  );
  const h = await harness(model.url);
  try {
    await h.post("/jobs", {
      execution: execution({
        agent: { model: "primary", tools: [lookup], text: { format: jsonSchema } },
      }),
      operationId: "start",
    });
    const batch = await h.untilStatus("turn_first", ["completed", "failed"]);
    const offered = model.requests.map((request) => ({
      tools: toolNames(request),
      choice: request.body.tool_choice,
    }));
    expect(batch.status, `${JSON.stringify(offered)}\n${h.diagnostics.join("\n")}`).toBe(
      "completed",
    );
    expect(model.requests).toHaveLength(1);
    expect(model.requests[0]?.body.tool_choice).toBe("required");
    expect(toolNames(model.requests[0] as ChatRequest)).toContain("workspace_function_0");
    const finals = ofType(batch, "text").filter((event) => event.phase === "final_answer");
    expect(finals).toHaveLength(1);
    expect(JSON.parse(finals[0]?.text ?? "")).toEqual({ answer: "forty-two", confidence: 0.9 });
    expect(ofType(batch, "text").map((event) => event.phase)).toEqual([
      "commentary",
      "final_answer",
    ]);
  } finally {
    await h.close();
  }
});

it("a model that answers in prose instead of the schema fails the turn", async () => {
  const model = await chatFixture(() => ({ text: '{"answer":"forty-two","confidence":0.9}' }));
  const h = await harness(model.url);
  try {
    await h.post("/jobs", {
      execution: execution({
        agent: { model: "primary", tools: [lookup], text: { format: jsonSchema } },
      }),
      operationId: "start",
    });
    const batch = await h.untilStatus("turn_first", ["completed", "failed"]);
    expect(batch.status).toBe("failed");
    expect(batch.error).toBe("internal_error");
    expect(h.diagnostics.some((line) => line.includes("StructuredOutputError"))).toBe(true);
  } finally {
    await h.close();
  }
});

it.each([
  ["high", "high"],
  ["none", undefined],
] as const)("reasoning effort %s reaches the model as %s", async (effort, expected) => {
  const model = await chatFixture(() => ({ text: "done" }));
  const h = await harness(model.url);
  try {
    await h.post("/jobs", {
      execution: execution({ agent: { model: "primary", tools: [lookup], reasoning: { effort } } }),
      operationId: "start",
    });
    const batch = await h.untilStatus("turn_first", ["completed", "failed"]);
    expect(batch.status, h.diagnostics.join("\n")).toBe("completed");
    expect(model.requests[0]?.body.reasoning_effort).toBe(expected);
  } finally {
    await h.close();
  }
});

it("text before a tool call is commentary and the last text is the final answer", async () => {
  const model = await chatFixture((request) =>
    textOf(request).includes("looked-up")
      ? { text: "Final answer." }
      : {
          text: "Let me check.",
          toolCalls: [{ name: "workspace_function_0", args: { query: "x" } }],
        },
  );
  const h = await harness(model.url);
  try {
    await h.post("/jobs", { execution: execution({}), operationId: "start" });
    const waiting = await h.untilStatus("turn_first", ["waiting", "completed", "failed"]);
    expect(waiting.status, h.diagnostics.join("\n")).toBe("waiting");
    const call = ofType(waiting, "function_call")[0];
    expect(call?.name).toBe("lookup");
    await h.post("/jobs/turn_first/control", {
      operationId: "result",
      command: { type: "tool_result", callId: call?.callId, success: true, output: "looked-up" },
    });
    const batch = await h.untilStatus("turn_first", ["completed", "failed"]);
    expect(batch.status, h.diagnostics.join("\n")).toBe("completed");
    const texts = ofType(batch, "text");
    expect(texts.map((event) => [event.text, event.phase])).toEqual([
      ["Let me check.", "commentary"],
      ["Final answer.", "final_answer"],
    ]);
  } finally {
    await h.close();
  }
});

it.each([
  [429, "rate_limit_exceeded"],
  [401, "authentication_error"],
  [503, "server_overloaded"],
] as const)("provider status %s fails the turn with %s", async (status, code) => {
  // OpenCode retries retryable statuses up to five times; retry-after-ms bounds the wait.
  const model = await chatFixture(() => ({
    status,
    body: { error: { message: "scripted" } },
    headers: { "retry-after-ms": "20" },
  }));
  const h = await harness(model.url);
  try {
    await h.post("/jobs", { execution: execution({}), operationId: "start" });
    const batch = await h.untilStatus("turn_first", ["completed", "failed"]);
    expect(batch.status).toBe("failed");
    expect(batch.error, h.diagnostics.join("\n")).toBe(code);
    expect(model.requests.length).toBe(status === 401 ? 1 : 6);
  } finally {
    await h.close();
  }
});

it("steering reaches the model within the same turn", async () => {
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const model = await chatFixture((request, index) =>
    index === 0
      ? {
          text: "Working.",
          hold: held,
          toolCalls: [{ name: "workspace_function_0", args: { query: "a" } }],
        }
      : textOf(request).includes("steered-instruction")
        ? { text: "Steered answer." }
        : { text: "Unsteered answer." },
  );
  const h = await harness(model.url);
  try {
    await h.post("/jobs", { execution: execution({}), operationId: "start" });
    // The first model call is held open: the turn is running and steerable.
    await expect
      .poll(() => model.requests.length, { timeout: 20_000, interval: 50 })
      .toBeGreaterThan(0);
    await delay(200);
    const steer = await h.post("/jobs/turn_first/control", {
      operationId: "steer",
      command: {
        type: "steer",
        input: [{ role: "user", content: [{ type: "input_text", text: "steered-instruction" }] }],
      },
    });
    expect(steer.status, `${await steer.text()}\n${h.diagnostics.join("\n")}`).toBe(204);
    release();
    const waiting = await h.untilStatus("turn_first", ["waiting", "completed", "failed"]);
    expect(waiting.status, h.diagnostics.join("\n")).toBe("waiting");
    const call = ofType(waiting, "function_call")[0];
    await h.post("/jobs/turn_first/control", {
      operationId: "result",
      command: { type: "tool_result", callId: call?.callId, success: true, output: "looked-up" },
    });
    const batch = await h.untilStatus("turn_first", ["completed", "failed"]);
    expect(batch.status, h.diagnostics.join("\n")).toBe("completed");
    // The inference right after the tool result already carries the steered input.
    expect(model.requests, model.requests.map(textOf).join("\n---\n")).toHaveLength(2);
    expect(textOf(model.requests[1] as ChatRequest)).toContain("steered-instruction");
    expect(textOf(model.requests[1] as ChatRequest)).toContain("looked-up");
    expect(ofType(batch, "text").map((event) => [event.text, event.phase])).toEqual([
      ["Working.", "commentary"],
      ["Steered answer.", "final_answer"],
    ]);
    const usage = ofType(batch, "usage").at(-1);
    expect(usage?.usage.input_tokens).toBe(10 * model.requests.length);
    // The turn has settled: a late steer is rejected so the Worker queues it as the next turn.
    const late = await h.post("/jobs/turn_first/control", {
      operationId: "late",
      command: {
        type: "steer",
        input: [{ role: "user", content: [{ type: "input_text", text: "too late" }] }],
      },
    });
    expect(late.status).toBe(409);
    expect(await late.json()).toMatchObject({ code: "command_rejected" });
  } finally {
    await h.close();
  }
});

it("native subagents are projected with their own turn and routed tool results", async () => {
  // Only the parent is offered `task`; the child answers once its lookup result is in its history.
  const model = await chatFixture((request) => {
    const history = textOf(request);
    if (toolNames(request).includes("task"))
      return history.includes("child-done")
        ? { text: "Parent final." }
        : {
            text: "Delegating.",
            toolCalls: [
              {
                name: "task",
                args: {
                  description: "Check the value",
                  prompt: "child-task: look up the value",
                  subagent_type: "cf-subagent",
                },
              },
            ],
          };
    return history.includes("child-value")
      ? { text: "child-done" }
      : { toolCalls: [{ name: "workspace_function_0", args: { query: "child" } }] };
  });
  const h = await harness(model.url);
  try {
    await h.post("/jobs", {
      execution: execution({
        agent: { model: "primary", tools: [lookup], multi_agent: { enabled: true } },
      }),
      operationId: "start",
    });
    const waiting = await h.untilStatus("turn_first", ["waiting", "completed", "failed"]);
    expect(waiting.status, h.diagnostics.join("\n")).toBe("waiting");
    const subagent = ofType(waiting, "subagent")[0];
    expect(subagent?.status).toBe("active");
    const childTurn = ofType(waiting, "subagent_turn")[0];
    expect(childTurn?.subagentId).toBe(subagent?.id);
    const call = ofType(waiting, "function_call")[0];
    expect(call?.subagentId).toBe(subagent?.id);
    expect(call?.turnId).toBe(childTurn?.id);
    await h.post("/jobs/turn_first/control", {
      operationId: "result",
      command: { type: "tool_result", callId: call?.callId, success: true, output: "child-value" },
    });
    const batch = await h.untilStatus("turn_first", ["completed", "failed"]);
    expect(batch.status, h.diagnostics.join("\n")).toBe("completed");
    const turns = ofType(batch, "subagent_turn");
    expect(turns.at(-1)?.status).toBe("completed");
    expect(ofType(batch, "subagent").at(-1)?.status).toBe("closed");
    expect(
      ofType(batch, "text").some(
        (event) => event.subagentId === subagent?.id && event.text === "child-done",
      ),
    ).toBe(true);
    expect(
      ofType(batch, "text").some((event) => !event.subagentId && event.text === "Parent final."),
    ).toBe(true);
    expect(ofType(batch, "usage").some((event) => event.subagentId === subagent?.id)).toBe(true);
  } finally {
    await h.close();
  }
});
