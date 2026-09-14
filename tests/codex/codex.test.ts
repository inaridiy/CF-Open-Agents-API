import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { afterEach, expect, it } from "vitest";

import type { Execution, RuntimeEvent } from "../../packages/agent-api/src/index.js";
import { CodexJob } from "../../packages/supervisor/src/codex.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const callback of cleanup.reverse()) await callback();
  cleanup.length = 0;
});

it("runs native Codex shell calls in the separate exec-server workspace and restores native history", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cf-open-agents-api-codex-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const harness = join(directory, "harness");
  const sandbox = join(directory, "sandbox");
  await mkdir(harness);
  await mkdir(sandbox);
  const requests: Record<string, unknown>[] = [];
  let commandIssued = false;
  let functionIssued = false;
  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    const chunks: Uint8Array[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
    requests.push(body);
    response.writeHead(200, { "content-type": "text/event-stream" });
    const send = (type: string, data: object) =>
      response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    send("response.created", {
      response: { id: "resp_test", object: "response", status: "in_progress", output: [] },
    });
    let output: object[];
    if (!commandIssued) {
      commandIssued = true;
      const tools = body.tools as { name?: string; type: string }[];
      expect(tools.some((tool) => tool.name === "exec_command")).toBe(true);
      output = [
        {
          type: "function_call",
          id: "fc_test",
          call_id: "call_test",
          name: "exec_command",
          arguments: JSON.stringify({
            cmd: `printf '%s' "$CF_AGENT_EXEC_PROOF" > '${sandbox}/proof.txt'`,
            workdir: sandbox,
            max_output_tokens: 100,
          }),
        },
      ];
    } else if (!functionIssued) {
      functionIssued = true;
      output = [
        {
          type: "function_call",
          id: "fc_lookup",
          call_id: "lookup_1",
          name: "lookup",
          arguments: '{"query":"native-tools"}',
        },
      ];
    } else {
      output = [
        {
          type: "message",
          id: `msg_${requests.length}`,
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "Execution complete." }],
        },
      ];
    }
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
  };
  const provider = createServer((request, response) => {
    void handle(request, response);
  });
  provider.listen(0, "127.0.0.1");
  await once(provider, "listening");
  cleanup.push(() => new Promise<void>((resolve) => provider.close(() => resolve())));
  const address = provider.address();
  if (!address || typeof address === "string") throw new Error("No provider port");
  const reserve = createServer();
  reserve.listen(0, "127.0.0.1");
  await once(reserve, "listening");
  const port = reserve.address();
  if (!port || typeof port === "string") throw new Error("No exec port");
  await new Promise<void>((resolve) => reserve.close(() => resolve()));
  const executor = spawn("codex", ["exec-server", "--listen", `ws://127.0.0.1:${port.port}`], {
    cwd: sandbox,
    env: { PATH: process.env.PATH, HOME: sandbox, CF_AGENT_EXEC_PROOF: "isolated" },
    stdio: "pipe",
  });
  cleanup.push(async () => {
    executor.kill("SIGTERM");
    await once(executor, "exit");
  });
  const diagnostics: string[] = [];
  executor.stderr.on("data", (data) => diagnostics.push(String(data)));
  const execution: Execution = {
    sessionId: "sess_test",
    turnId: "turn_test",
    generation: 1,
    harness: "codex",
    model: "gpt-5.4",
    agent: {
      model: "test",
      tools: [
        {
          type: "function",
          name: "lookup",
          description: "Look up a value",
          parameters: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
            additionalProperties: false,
          },
        },
      ],
    },
    input: [
      { role: "user", content: [{ type: "input_text", text: "Run the command, then report." }] },
    ],
    checkpoint: null,
    deadline: Date.now() + 60_000,
    sandbox: true,
  };
  const options = {
    binary: "codex",
    directory: harness,
    modelBaseUrl: `http://127.0.0.1:${address.port}/v1`,
    sandboxUrl: `ws://127.0.0.1:${port.port}`,
    diagnostics: (line: string) => diagnostics.push(line),
  };
  const job = new CodexJob(execution, options);
  cleanup.push(() => job.stop());
  await job.start();
  let after = 0;
  const events: RuntimeEvent[] = [];
  for (let attempt = 0; attempt < 300; attempt++) {
    const batch = job.poll(after);
    events.push(...batch.events.map((entry) => entry.event));
    after = batch.cursor;
    if (batch.status === "waiting") {
      const call = batch.events.find((entry) => entry.event.type === "function_call")?.event;
      if (call?.type !== "function_call") throw new Error("Missing native function call");
      expect(call.name).toBe("lookup");
      await job.control("tool-result", {
        type: "tool_result",
        callId: call.callId,
        success: true,
        output: "external-tool-value",
      });
    } else if (batch.status !== "running") {
      expect(batch.status, diagnostics.join("\n")).toBe("completed");
      break;
    }
    await delay(100);
  }
  expect(
    events.some((event) => event.type === "command"),
    diagnostics.join("\n"),
  ).toBe(true);
  expect(await readFile(join(sandbox, "proof.txt"), "utf8")).toBe("isolated");
  expect(requests.length).toBeGreaterThanOrEqual(3);
  expect(JSON.stringify(requests.at(-1)?.input)).toContain("external-tool-value");
  const bundle = await job.checkpoint();
  expect(Object.keys(bundle.files).some((file) => file.includes("sessions/"))).toBe(true);
  await rm(job.home, { recursive: true, force: true });
  const resumed = new CodexJob(
    {
      ...execution,
      turnId: "turn_next",
      generation: 2,
      input: [{ role: "user", content: [{ type: "input_text", text: "What did you do?" }] }],
    },
    options,
  );
  cleanup.push(() => resumed.stop());
  await resumed.start(bundle);
  for (let attempt = 0; attempt < 300 && resumed.poll(0).status === "running"; attempt++)
    await delay(100);
  expect(resumed.poll(0).status, diagnostics.join("\n")).toBe("completed");
  expect(JSON.stringify(requests.at(-1)?.input)).toContain("Run the command");
});
