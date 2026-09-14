import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { expect, it } from "vitest";
import type { Execution, RuntimeBatch } from "../../packages/agent-api/src/index.js";
import { aiSDKModel, createModelGateway } from "../../packages/agent-api/src/models.js";
import { createSupervisor } from "../../packages/supervisor/src/server.js";
import { serveFetch } from "./http.js";

it.each(["claude-code", "opencode"])(
  "%s executes allowed MCP tools and discovers deferred functions",
  async (harness) => {
    const directory = await mkdtemp(join(tmpdir(), "cf-mcp-native-"));
    const diagnostics: string[] = [];
    let calls = 0;
    const mcp = await serveFetch(async (request) => {
      if (request.method !== "POST") return new Response(null, { status: 405 });
      const message = (await request.json()) as {
        id?: number;
        method: string;
        params?: { name: string };
      };
      if (message.id === undefined) return new Response(null, { status: 202 });
      if (message.method === "tools/call") {
        expect(message.params?.name).toBe("lookup");
        calls++;
      }
      return Response.json({
        jsonrpc: "2.0",
        id: message.id,
        result:
          message.method === "initialize"
            ? {
                protocolVersion: "2025-03-26",
                capabilities: { tools: {} },
                serverInfo: { name: "fixture", version: "1" },
              }
            : message.method === "tools/list"
              ? {
                  tools: ["lookup", "forbidden"].map((name) => ({
                    name,
                    description: name,
                    inputSchema: { type: "object", properties: {} },
                  })),
                }
              : { content: [{ type: "text", text: "MCP_PROOF" }] },
      });
    });
    const gateway = createModelGateway(() => ({
      primary: aiSDKModel(
        new MockLanguageModelV4({
          doStream: async ({ prompt, tools }) => {
            const history = JSON.stringify(prompt);
            const definitions = tools?.filter((tool) => tool.type === "function") ?? [];
            expect(JSON.stringify(definitions)).not.toContain("forbidden");
            expect(definitions.some((tool) => tool.name.endsWith("function_0"))).toBe(false);
            const complete = history.includes("DEFERRED_PROOF");
            const searched = history.includes('"role":"tool"') && history.includes("defer_loading");
            const received = history.includes("MCP_PROOF");
            const ending = !received ? "__lookup" : !searched ? "cf_tool_search" : "cf_call_tool";
            const selected = definitions.find((tool) => tool.name.endsWith(ending));
            if (!complete && !selected) throw new Error(`Missing tool ${ending}`);
            return {
              stream: simulateReadableStream({
                chunks: [
                  { type: "stream-start", warnings: [] },
                  ...(complete
                    ? [
                        { type: "text-start" as const, id: "answer" },
                        {
                          type: "text-delta" as const,
                          id: "answer",
                          delta: "MCP and deferred functions work.",
                        },
                        { type: "text-end" as const, id: "answer" },
                      ]
                    : [
                        {
                          type: "tool-call" as const,
                          toolCallId: `call_${crypto.randomUUID().replaceAll("-", "")}`,
                          toolName: selected?.name ?? "missing",
                          input: JSON.stringify(
                            !received
                              ? {}
                              : !searched
                                ? { query: "hidden_lookup" }
                                : { name: "hidden_lookup", arguments: { query: "proof" } },
                          ),
                        },
                      ]),
                  {
                    type: "finish",
                    finishReason: { unified: complete ? "stop" : "tool-calls", raw: "scripted" },
                    usage: {
                      inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
                      outputTokens: { total: 5, text: 5, reasoning: 0 },
                    },
                  },
                ],
              }),
            };
          },
        }),
      ),
    }));
    const model = await serveFetch((request) => gateway.fetch(request, {}));
    let supervisor: ReturnType<typeof createSupervisor>;
    const server = await serveFetch(async (request) => supervisor.app.fetch(request));
    supervisor = createSupervisor({
      binary: "codex",
      opencodeBinary: resolve("node_modules/.bin/opencode"),
      directory,
      modelBaseUrl: `${model.url}/v1`,
      sandboxUrl: "http://unused.invalid",
      supervisorUrl: server.url,
      diagnostics: (line) => diagnostics.push(line),
    });
    const execution: Execution = {
      sessionId: "sess_mcp",
      turnId: "turn_mcp",
      generation: 1,
      harness,
      model: "primary",
      agent: {
        model: "primary",
        tools: [
          {
            type: "function",
            name: "hidden_lookup",
            description: "Deferred proof",
            defer_loading: true,
            parameters: {
              type: "object",
              properties: { query: { type: "string" } },
              required: ["query"],
            },
          },
          {
            type: "mcp",
            server_label: "fixture",
            transport: { type: "http", server_url: mcp.url },
            allowed_tools: ["lookup"],
            required: true,
          },
        ],
      },
      input: [{ role: "user", content: [{ type: "input_text", text: "Verify tools." }] }],
      checkpoint: null,
      deadline: Date.now() + 30_000,
      sandbox: false,
    };
    try {
      const response = await fetch(`${server.url}/jobs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ execution, operationId: "start" }),
      });
      expect(response.ok, await response.text()).toBe(true);
      let done = false;
      const replied = new Set<string>();
      for (let attempt = 0; attempt < 500; attempt++) {
        const batch = (await (
          await fetch(`${server.url}/jobs/${execution.turnId}`)
        ).json()) as RuntimeBatch;
        expect(batch.status, `${batch.error}\n${diagnostics.join("\n")}`).not.toBe("failed");
        for (const { event } of batch.events)
          if (event.type === "function_call" && !replied.has(event.callId)) {
            expect(event.name).toBe("hidden_lookup");
            expect(event.arguments).toEqual({ query: "proof" });
            replied.add(event.callId);
            const result = await fetch(`${server.url}/jobs/${execution.turnId}/control`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                operationId: event.callId,
                command: {
                  type: "tool_result",
                  callId: event.callId,
                  success: true,
                  output: "DEFERRED_PROOF",
                },
              }),
            });
            expect(result.ok, await result.text()).toBe(true);
          }
        if (batch.status === "completed") {
          expect(
            batch.events.some(
              ({ event }) => event.type === "mcp" && event.server === "fixture" && event.success,
            ),
          ).toBe(true);
          done = true;
          break;
        }
        await delay(50);
      }
      expect(done, diagnostics.join("\n")).toBe(true);
      expect(calls).toBe(1);
    } finally {
      await supervisor.stop();
      await server.close();
      await model.close();
      await mcp.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
