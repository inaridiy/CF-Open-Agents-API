import { DurableObject } from "cloudflare:workers";
import { Effect } from "effect";
import type { EnvironmentInfo } from "openai/resources/beta/agents/environments/environments";

import ExampleCallerWorker from "../../examples/caller/src/index.js";
import { CatalogObject } from "../../packages/agent-api/src/catalog.js";
import type { EnvironmentDriver } from "../../packages/agent-api/src/environments.js";
import { ApiError } from "../../packages/agent-api/src/protocol.js";
import type {
  Execution,
  RuntimeBatch,
  RuntimeCommand,
  RuntimeDriver,
  RuntimeEvent,
} from "../../packages/agent-api/src/runtime.js";
import { fromPromiseDriver } from "../../packages/agent-api/src/runtime.js";
import {
  type AgentBindings,
  bearerTenant,
  createAgentService,
} from "../../packages/agent-api/src/service.js";

export interface TestEnv extends AgentBindings {
  SCRIPTED: DurableObjectNamespace<ScriptedHarness>;
  ASSETS: R2Bucket;
  AGENTS: Service<BindingAgentWorker>;
  API_TOKEN: string;
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
    const part = execution.input[0]?.content[0];
    const text = part?.type === "input_text" ? part.text : undefined;
    const status = await this.ctx.storage.get<string>("status");
    if (text === "hold" || status === "cancelled")
      return Response.json({
        status: status === "cancelled" ? "cancelled" : "running",
        events: [],
        cursor: 0,
      });
    if (text === "compat-tools") {
      const result = await this.ctx.storage.get<RuntimeCommand>("last-tool-result");
      const events: RuntimeEvent[] = [
        {
          type: "function_call",
          id: "lookup",
          callId: "lookup",
          name: "lookup",
          arguments: { query: "proof" },
        },
        ...(result
          ? [
              {
                type: "text" as const,
                id: "answer",
                text: "Tool received",
                phase: "final_answer" as const,
              },
            ]
          : []),
      ];
      return Response.json({
        status: result ? "completed" : "waiting",
        cursor: events.length,
        events: events.map((event, i) => ({ seq: i + 1, event })),
      });
    }
    if (text === "compat-stream" || text === "compat-cancel") {
      const usage = {
        input_tokens: 12,
        output_tokens: 8,
        total_tokens: 20,
        input_tokens_details: { cached_tokens: 3 },
        output_tokens_details: { reasoning_tokens: 5 },
      };
      const events: RuntimeEvent[] = [
        { type: "reasoning", id: "reason", summary: [], status: "in_progress" },
        { type: "reasoning_part", id: "reason", summaryIndex: 0, text: "" },
        { type: "reasoning_delta", id: "reason", summaryIndex: 0, text: "Checking the result." },
        { type: "command_start", id: "cmd", command: "pwd", cwd: "/workspace/project" },
        { type: "command_delta", id: "cmd", text: "/workspace/project\n" },
        { type: "usage", id: "usage", usage },
        ...(text === "compat-cancel"
          ? []
          : [
              {
                type: "reasoning" as const,
                id: "reason",
                summary: ["Checking the result."],
                status: "completed" as const,
              },
              {
                type: "command" as const,
                id: "cmd",
                command: "pwd",
                cwd: "/workspace/project",
                output: "/workspace/project\n",
                durationMs: 7,
                exitCode: 0,
              },
              {
                type: "web_search" as const,
                id: "search",
                action: { type: "search" as const, query: "fixture", queries: null },
                status: "completed" as const,
              },
              { type: "usage" as const, id: "usage", usage },
              {
                type: "text" as const,
                id: "answer",
                text: "Verified",
                phase: "final_answer" as const,
              },
            ]),
      ];
      return Response.json({
        status: text === "compat-cancel" ? "running" : "completed",
        cursor: events.length,
        events: events.map((event, i) => ({ seq: i + 1, event })),
      });
    }
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
    if (command.type === "tool_result") await this.ctx.storage.put("last-tool-result", command);
  }
  async toolResult(): Promise<RuntimeCommand | undefined> {
    return this.ctx.storage.get<RuntimeCommand>("last-tool-result");
  }
  /** Serialized: the RPC type of the execution's agent configuration is too deep. */
  async started(): Promise<string> {
    const execution = await this.ctx.storage.get<Execution>("execution");
    return JSON.stringify(
      execution
        ? {
            input: execution.input,
            delegates: execution.delegates ?? null,
            maxConcurrentSubagents: execution.maxConcurrentSubagents ?? null,
          }
        : null,
    );
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
function fixture(env: TestEnv, name = "fixture"): RuntimeDriver {
  const stub = (execution: Execution) => env.SCRIPTED.getByName(execution.turnId);
  return fromPromiseDriver({
    name,
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
        driver: name,
        revision: "test-v1",
        native: `checkpoint/${execution.turnId}`,
      };
    },
    stop: async (execution) => {
      await stub(execution).stop();
    },
  });
}
/** Scripted environment driver: setup is a no-op and the status is read from R2 so tests can flip it. */
function scriptedEnvironments(env: TestEnv): EnvironmentDriver {
  const unavailable = () =>
    Effect.fail(
      new ApiError(503, "environment_unavailable", "Scripted environments hold no files"),
    );
  return {
    prepare: () => Effect.void,
    status: (spec) =>
      Effect.promise(async () => {
        const stored = await env.ASSETS.get(`environment-status/${spec.sessionId}`);
        return ((await stored?.text()) ?? "connected") as EnvironmentInfo["status"];
      }),
    upload: unavailable,
    files: unavailable,
  };
}
const service = createAgentService<TestEnv>({
  objects: (env) => env.ASSETS,
  environments: scriptedEnvironments,
  agents: {
    test: { harness: "fixture", model: "fixture-model" },
    "test-images": { harness: "fixture-images", model: "fixture-model" },
    "test-tools": { harness: "fixture-tools", model: "fixture-model" },
    // Hosted web search needs the harness flag and the alias's model connection.
    "test-search": { harness: "fixture-search", model: "fixture-model", webSearch: true },
    "test-search-unflagged": { harness: "fixture-search", model: "fixture-model" },
    "test-hosted": { harness: "fixture-hosted", model: "fixture-model" },
    // Cross-runtime delegation is deployment configuration, not a runtime capability.
    "test-lead": { harness: "fixture", model: "fixture-model", delegates: ["test-tools"] },
    "test-misconfigured": { harness: "fixture", model: "fixture-model", delegates: ["absent"] },
  },
  harnesses: (env) => ({
    fixture: fixture(env),
    "fixture-images": {
      ...fixture(env, "fixture-images"),
      capabilities: { ...fixture(env).capabilities, images: true },
    },
    "fixture-tools": {
      ...fixture(env, "fixture-tools"),
      capabilities: {
        ...fixture(env).capabilities,
        mcp: true,
        toolSearch: true,
        toolsFixedAtStart: true,
      },
    },
    "fixture-search": {
      ...fixture(env, "fixture-search"),
      capabilities: { ...fixture(env).capabilities, webSearch: true },
    },
    "fixture-hosted": {
      ...fixture(env, "fixture-hosted"),
      capabilities: { ...fixture(env).capabilities, sandbox: true },
    },
  }),
  authenticate: async (request) =>
    request.headers.get("authorization")?.replace("Bearer ", "") ?? null,
  pollIntervalMs: 60_000,
});
export class SessionDO extends service.SessionDO {}
export class CatalogDO extends CatalogObject {}
export default class TestWorker extends service.AgentWorker {}

const bindingService = createAgentService<TestEnv>({
  agents: { test: { harness: "fixture", model: "fixture-model" } },
  harnesses: (env) => ({ fixture: fixture(env) }),
  authenticate: (request, env) => bearerTenant(request, env.API_TOKEN, "default"),
  pollIntervalMs: 60_000,
});
export class BindingAgentWorker extends bindingService.AgentWorker {}
export class CallerWorker extends ExampleCallerWorker {}
