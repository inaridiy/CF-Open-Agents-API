import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { afterEach, expect, it } from "vitest";

import type { Execution, RuntimeBatch, RuntimeEvent } from "../../packages/agent-api/src/index.js";
import { CodexJob, type CodexOptions, turnErrorCode } from "../../packages/supervisor/src/codex.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const callback of cleanup.reverse()) await callback();
  cleanup.length = 0;
});

type Script = (body: Record<string, unknown>, response: ServerResponse, count: number) => void;

/** Stream one completed Responses API response carrying `output`. */
function complete(response: ServerResponse, output: object[]): void {
  response.writeHead(200, { "content-type": "text/event-stream" });
  const send = (type: string, data: object) =>
    response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  send("response.created", {
    response: { id: "resp_test", object: "response", status: "in_progress", output: [] },
  });
  output.forEach((item, index) => {
    send("response.output_item.done", { output_index: index, item });
  });
  send("response.completed", {
    response: {
      id: "resp_test",
      object: "response",
      status: "completed",
      output,
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    },
  });
  response.end();
}
const message = (text: string) => ({
  type: "message",
  id: `msg_${Math.random().toString(36).slice(2)}`,
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text }],
});

/** Run one Codex turn against a scripted provider until it reaches a terminal status. */
async function runCodex(
  script: Script,
  overrides: {
    agent?: Partial<Execution["agent"]>;
    codexConfig?: CodexOptions["codexConfig"];
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "cf-codex-errors-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const requests: Record<string, unknown>[] = [];
  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    const chunks: Uint8Array[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
    requests.push(body);
    script(body, response, requests.length);
  };
  const provider = createServer((request, response) => {
    void handle(request, response);
  });
  provider.listen(0, "127.0.0.1");
  await once(provider, "listening");
  cleanup.push(() => new Promise<void>((resolve) => provider.close(() => resolve())));
  const address = provider.address();
  if (!address || typeof address === "string") throw new Error("No provider port");
  const diagnostics: string[] = [];
  const execution: Execution = {
    sessionId: "sess_errors",
    turnId: "turn_errors",
    generation: 1,
    harness: "codex",
    model: "gpt-5.4",
    agent: { model: "test", ...overrides.agent },
    input: [{ role: "user", content: [{ type: "input_text", text: "Answer briefly." }] }],
    checkpoint: null,
    deadline: Date.now() + 60_000,
    sandbox: false,
  };
  const job = new CodexJob(execution, {
    binary: "codex",
    directory,
    modelBaseUrl: `http://127.0.0.1:${address.port}/v1`,
    sandboxUrl: "ws://unused",
    diagnostics: (line) => diagnostics.push(line),
    ...(overrides.codexConfig ? { codexConfig: overrides.codexConfig } : {}),
  });
  cleanup.push(() => job.stop());
  await job.start();
  let batch: RuntimeBatch = job.poll(0);
  const events: RuntimeEvent[] = [];
  let after = 0;
  for (let attempt = 0; attempt < 400; attempt++) {
    batch = job.poll(after);
    events.push(...batch.events.map((entry) => entry.event));
    after = batch.cursor;
    if (batch.status !== "running" && batch.status !== "waiting") break;
    await delay(100);
  }
  return { batch, events, requests, diagnostics };
}

// Retries are disabled so a scripted provider failure reaches turn/completed promptly.
const noRetries = { provider: { request_max_retries: 0, stream_max_retries: 0 } };

it.each([
  [
    "unauthorized",
    401,
    { type: "invalid_request_error", code: "invalid_api_key", message: "Incorrect API key" },
    "authentication_error",
  ],
  [
    "rate limited",
    429,
    { type: "rate_limit_error", code: "rate_limit_exceeded", message: "Rate limit reached" },
    "rate_limit_exceeded",
  ],
  [
    "server error",
    500,
    { type: "server_error", code: null, message: "The server had an error" },
    "server_error",
  ],
  [
    "context window",
    400,
    {
      type: "invalid_request_error",
      code: "context_length_exceeded",
      message: "Your input exceeds the context window of this model",
    },
    "context_length_exceeded",
  ],
])(
  "maps a %s provider failure to the public turn error code",
  async (_name, status, error, code) => {
    const { batch, diagnostics } = await runCodex(
      (_body, response) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify({ error }));
      },
      { codexConfig: noRetries },
    );
    expect(batch.status, diagnostics.join("\n")).toBe("failed");
    expect(batch.error, diagnostics.join("\n")).toBe(code);
    expect(diagnostics.some((line) => line.includes("codexErrorInfo="))).toBe(true);
  },
);

it("maps every documented codexErrorInfo variant without throwing", () => {
  expect(turnErrorCode("contextWindowExceeded")).toBe("context_length_exceeded");
  expect(turnErrorCode({ httpConnectionFailed: { httpStatusCode: 502 } })).toBe("server_error");
  expect(turnErrorCode({ httpConnectionFailed: { httpStatusCode: null } })).toBe(
    "connection_failed",
  );
  expect(turnErrorCode({ responseTooManyFailedAttempts: { httpStatusCode: 429 } })).toBe(
    "rate_limit_exceeded",
  );
  expect(turnErrorCode("other", "unexpected status 401 Unauthorized: bad key")).toBe(
    "authentication_error",
  );
  expect(turnErrorCode("other", '{"error":{"code":"context_length_exceeded"}}')).toBe(
    "context_length_exceeded",
  );
  expect(turnErrorCode("other", "something else")).toBe("internal_error");
  expect(turnErrorCode({ activeTurnNotSteerable: { turnKind: "review" } })).toBe(
    "active_turn_not_steerable",
  );
  expect(turnErrorCode("other")).toBe("internal_error");
  expect(turnErrorCode(null)).toBe("internal_error");
  expect(turnErrorCode(undefined)).toBe("internal_error");
});

/**
 * Codex 0.154.0 carries `turn/start.outputSchema` to the gateway as the Responses
 * API `text.format` object (`{ type: "json_schema", strict: true, schema, name }`),
 * next to `text.verbosity`; it never sends `output_config` or `response_format`.
 * The portable gateway must translate that field for structured output.
 */
it("sends a json_schema output format to the gateway as text.format", async () => {
  const schema = {
    type: "object",
    properties: { ok: { type: "boolean" } },
    required: ["ok"],
    additionalProperties: false,
  };
  const { batch, requests, diagnostics } = await runCodex(
    (_body, response) => complete(response, [message('{"ok":true}')]),
    { agent: { text: { format: { type: "json_schema", schema }, verbosity: "low" } } },
  );
  expect(batch.status, diagnostics.join("\n")).toBe("completed");
  const body = requests[0] as {
    text?: unknown;
    output_config?: unknown;
    response_format?: unknown;
  };
  expect(body.text).toEqual({
    verbosity: "low",
    format: { type: "json_schema", strict: true, schema, name: "codex_output_schema" },
  });
  expect(body.output_config).toBeUndefined();
  expect(body.response_format).toBeUndefined();
});
