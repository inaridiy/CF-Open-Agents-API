import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { expect, it } from "vitest";
import {
  type Execution,
  HARNESSES,
  type HarnessName,
  type RuntimeBatch,
} from "../../packages/agent-api/src/index.js";
import { aiSDKModel, createModelGateway } from "../../packages/agent-api/src/models.js";
import { createSupervisor } from "../../packages/supervisor/src/server.js";
import { serveFetch } from "./http.js";

it.each<HarnessName>(["codex", "claude-code", "opencode"])(
  "%s uses an AI SDK model, external tools, and native checkpoints",
  async (harness) => {
    // This name remains an ordinary client function when code mode is disabled.
    const functionName = harness === "codex" ? "cf_execute" : "lookup";
    const root = await mkdtemp(join(tmpdir(), "cf-native-"));
    const directory = join(root, "harness");
    await mkdir(directory);
    const diagnostics: string[] = [];
    const requests: string[] = [];
    const instance = new MockLanguageModelV4({
      modelId: "scripted-model-instance",
      doStream: async ({ prompt, tools }) => {
        const history = JSON.stringify(prompt);
        requests.push(history);
        const restored = history.includes("verify-restored");
        if (restored) expect(history).toContain("durable-value");
        const hasResult = history.includes("durable-value");
        const definition = tools?.find(
          (tool) =>
            tool.type === "function" &&
            (tool.name === functionName || tool.name.endsWith("function_0")),
        );
        if (!definition)
          throw new Error(`Native external tool is missing: ${JSON.stringify(tools)}`);
        const toolCall = !hasResult || history.includes("verify-cancel");
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              ...(toolCall
                ? [
                    {
                      type: "tool-call" as const,
                      toolCallId: `call_${crypto.randomUUID().replaceAll("-", "")}`,
                      toolName: definition.name,
                      input: '{"query":"durable"}',
                    },
                  ]
                : [
                    { type: "text-start" as const, id: "text_provider" },
                    {
                      type: "text-delta" as const,
                      id: "text_provider",
                      delta: restored ? "Native history restored." : "Tool received.",
                    },
                    { type: "text-end" as const, id: "text_provider" },
                  ]),
              {
                type: "finish",
                finishReason: { unified: toolCall ? "tool-calls" : "stop", raw: undefined },
                usage: {
                  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
                  outputTokens: { total: 5, text: 5, reasoning: 0 },
                },
              },
            ],
          }),
        };
      },
    });
    const gateway = createModelGateway(() => ({ primary: aiSDKModel(instance) }));
    const model = await serveFetch(async (request) => {
      const body = (await request.clone().json()) as Record<string, unknown>;
      diagnostics.push(
        JSON.stringify({
          path: new URL(request.url).pathname,
          keys: Object.keys(body),
          tools: (body.tools as { type: string; name?: string }[] | undefined)?.map(
            ({ type, name }) => ({ type, name }),
          ),
          store: body.store,
          output_config: body.output_config,
          text: body.text,
        }),
      );
      return gateway.fetch(request, {});
    });
    let supervisor: ReturnType<typeof createSupervisor> | undefined;
    const server = await serveFetch(async (request) =>
      supervisor ? supervisor.app.fetch(request) : new Response(null, { status: 503 }),
    );
    const options = {
      binary: "codex",
      directory,
      modelBaseUrl: `${model.url}/v1`,
      sandboxUrl: "http://unused.invalid",
      supervisorUrl: server.url,
      opencodeBinary: resolve("node_modules/.bin/opencode"),
      diagnostics: (line: string) => diagnostics.push(line),
    };
    const execution: Execution = {
      sessionId: "sess_native",
      turnId: "turn_first",
      generation: 1,
      harness,
      model: "primary",
      agent: {
        model: "agent-preset",
        instructions: "Use the configured lookup function.",
        tools: [
          {
            type: "function",
            name: functionName,
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
      input: [{ role: "user", content: [{ type: "input_text", text: "Find the durable value." }] }],
      checkpoint: null,
      deadline: Date.now() + 50_000,
      sandbox: false,
    };
    async function post(path: string, body: unknown) {
      const response = await fetch(server.url + path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(response.ok, `${await response.text()}\n${diagnostics.join("\n")}`).toBe(true);
    }
    async function complete(turnId: string) {
      for (let i = 0; i < 400; i++) {
        const batch = (await (await fetch(`${server.url}/jobs/${turnId}`)).json()) as RuntimeBatch;
        expect(batch.status, `${batch.error}\n${diagnostics.join("\n")}`).not.toBe("failed");
        if (batch.status === "waiting") {
          const call = batch.events.find((entry) => entry.event.type === "function_call")?.event;
          if (call?.type !== "function_call") throw new Error("Missing pending tool");
          expect(call.name).toBe(functionName);
          await post(`/jobs/${turnId}/control`, {
            operationId: `${turnId}:result`,
            command: {
              type: "tool_result",
              callId: call.callId,
              success: true,
              output: "durable-value",
            },
          });
        }
        if (batch.status === "completed") return batch;
        await delay(50);
      }
      throw new Error(`Native turn timed out\n${diagnostics.join("\n")}`);
    }
    try {
      supervisor = createSupervisor(options);
      await post("/jobs", { execution, operationId: "first" });
      expect(JSON.stringify(await complete(execution.turnId))).toContain("Tool received.");
      const response = await fetch(`${server.url}/jobs/${execution.turnId}/checkpoint`);
      expect(response.ok, response.ok ? "" : await response.clone().text()).toBe(true);
      const checkpoint = await response.json();
      await supervisor.stop();
      await rm(directory, { recursive: true, force: true });
      await mkdir(directory);
      supervisor = createSupervisor(options);
      const resumed: Execution = {
        ...execution,
        turnId: "turn_second",
        generation: 2,
        checkpoint: {
          version: 1,
          driver: harness,
          revision: HARNESSES[harness].revision,
          native: "fixture.json",
        },
        input: [{ role: "user", content: [{ type: "input_text", text: "verify-restored" }] }],
      };
      await post("/jobs", { execution: resumed, operationId: "second", checkpoint });
      expect(JSON.stringify(await complete(resumed.turnId))).toContain("Native history restored.");
      expect(requests.length).toBeGreaterThanOrEqual(3);
      const cancelled: Execution = {
        ...resumed,
        turnId: "turn_cancel",
        generation: 3,
        input: [{ role: "user", content: [{ type: "input_text", text: "verify-cancel" }] }],
      };
      await post("/jobs", { execution: cancelled, operationId: "cancel-start", checkpoint });
      for (let i = 0; ; i++) {
        const batch = (await (
          await fetch(`${server.url}/jobs/${cancelled.turnId}`)
        ).json()) as RuntimeBatch;
        if (batch.status === "waiting") break;
        if (i > 200 || batch.status === "failed")
          throw new Error(`Turn did not reach tool waiting: ${JSON.stringify(batch)}`);
        await delay(50);
      }
      await post(`/jobs/${cancelled.turnId}/control`, {
        operationId: "cancel",
        command: { type: "cancel" },
      });
      await expect
        .poll(
          async () => {
            const batch = (await (
              await fetch(`${server.url}/jobs/${cancelled.turnId}`)
            ).json()) as RuntimeBatch;
            return batch.status;
          },
          { timeout: 5000, interval: 50 },
        )
        .toBe("cancelled");
    } finally {
      await supervisor?.stop();
      await server.close();
      await model.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
