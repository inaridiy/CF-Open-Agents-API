import { DurableObject } from "cloudflare:workers";
import { MockLanguageModelV4 } from "ai/test";
import {
  type AIHarnessBindings,
  aiSDKDriver,
  createAIHarness,
} from "../../packages/agent-api/src/ai-sdk.js";
import { CatalogObject } from "../../packages/agent-api/src/catalog.js";
import type {
  Execution,
  RuntimeBatch,
  RuntimeCommand,
  RuntimeDriver,
} from "../../packages/agent-api/src/runtime.js";
import { type AgentBindings, createAgentService } from "../../packages/agent-api/src/service.js";

export interface TestEnv extends AgentBindings, AIHarnessBindings {
  SCRIPTED: DurableObjectNamespace<ScriptedHarness>;
  ASSETS: R2Bucket;
}

/** Protocol fixture only. Never exported by the production package or example. */
export class ScriptedHarness extends DurableObject {
  async start(execution: Execution): Promise<void> {
    if (await this.ctx.storage.get("execution")) return;
    await this.ctx.storage.put({ execution, status: "running", starts: 1, commands: [] });
  }
  async poll(): Promise<Response> {
    const execution = await this.ctx.storage.get<Execution>("execution");
    if (!execution) return Response.json({ status: "missing", events: [], cursor: 0 });
    const text = execution.input[0]?.content[0]?.text;
    const status = await this.ctx.storage.get<string>("status");
    if (text === "hold" || status === "cancelled")
      return Response.json({
        status: status === "cancelled" ? "cancelled" : "running",
        events: [],
        cursor: 0,
      });
    if (text === "many-events")
      return Response.json({
        status: "completed",
        cursor: 301,
        events: [
          ...Array.from({ length: 300 }, (_, i) => ({
            seq: i + 1,
            event: { type: "delta", id: "long", text: "x".repeat(256) },
          })),
          {
            seq: 301,
            event: { type: "text", id: "long", text: "x".repeat(300 * 256), phase: "final_answer" },
          },
        ],
      });
    return Response.json({
      status: "completed",
      events: [
        {
          seq: 1,
          event: { type: "text", id: "msg_result", text: "Fixture output", phase: "final_answer" },
        },
      ],
      cursor: 1,
    });
  }
  async control(id: string, command: RuntimeCommand): Promise<void> {
    if (await this.ctx.storage.get(id)) return;
    await this.ctx.storage.put(id, command);
    if (command.type === "cancel") await this.ctx.storage.put("status", "cancelled");
  }
  async vanish(): Promise<void> {
    await this.ctx.storage.delete("execution");
  }
  async stop(): Promise<void> {
    await this.ctx.storage.put("stopped", true);
  }
  async snapshot(): Promise<void> {
    await this.ctx.storage.put("checkpointed", true);
  }
}
function fixture(env: TestEnv): RuntimeDriver {
  const stub = (execution: Execution) => env.SCRIPTED.getByName(execution.turnId);
  return {
    name: "fixture",
    revision: "test-v1",
    capabilities: { steer: true, functions: true, sandbox: false },
    start: async (execution) => {
      await stub(execution).start(execution);
    },
    poll: async (execution) => (await stub(execution).poll()).json<RuntimeBatch>(),
    control: async (execution, id, command) => {
      await stub(execution).control(id, command);
    },
    checkpoint: async (execution) => {
      await stub(execution).snapshot();
      return {
        version: 1,
        driver: "fixture",
        revision: "test-v1",
        native: `checkpoint/${execution.turnId}`,
      };
    },
    stop: async (execution) => {
      await stub(execution).stop();
    },
  };
}
const service = createAgentService<TestEnv>({
  models: {
    test: { driver: "fixture", model: "fixture-model" },
    ai: { driver: "ai-sdk", model: "scripted-v4" },
  },
  drivers: (env) => ({ fixture: fixture(env), "ai-sdk": aiSDKDriver(env) }),
  authenticate: async (request) =>
    request.headers.get("authorization")?.replace("Bearer ", "") ?? null,
  pollIntervalMs: 60_000,
});
export class SessionDO extends service.SessionDO {}
export class CatalogDO extends CatalogObject {}
export default class TestWorker extends service.AgentWorker {}

const AIHarness = createAIHarness<TestEnv>(
  () =>
    new MockLanguageModelV4({
      doGenerate: async ({ prompt, tools }) => {
        const hasResult = prompt.some((message) => message.role === "tool");
        const needsTool = (tools?.length ?? 0) > 0 && !hasResult;
        return {
          content: needsTool
            ? [
                {
                  type: "tool-call",
                  toolCallId: "call_ai",
                  toolName: "lookup",
                  input: '{"query":"cloudflare"}',
                },
              ]
            : [
                {
                  type: "text",
                  text: hasResult ? "Result received; history restored." : "AI SDK output.",
                },
              ],
          finishReason: { unified: needsTool ? "tool-calls" : "stop", raw: undefined },
          usage: {
            inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 5, text: 5, reasoning: 0 },
          },
          warnings: [],
        };
      },
    }),
);
export class AIHarnessDO extends AIHarness {}
