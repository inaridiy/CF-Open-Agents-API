import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { expect, it } from "vitest";
import type { Execution, RuntimeBatch, RuntimeEvent } from "../../packages/agent-api/src/index.js";
import { aiSDKModel, createModelGateway } from "../../packages/agent-api/src/models.js";
import { createSupervisor } from "../../packages/supervisor/src/server.js";
import { serveFetch } from "./http.js";

/** The HarnessDO streams command output as NDJSON; file tools answer with plain JSON. */
it.each(["claude-code", "opencode"])(
  "%s replacement workspace tools return sandbox results from the streamed transport",
  async (harness) => {
    const directory = await mkdtemp(join(tmpdir(), "cf-workspace-"));
    const diagnostics: string[] = [];
    const calls: { tool: string; arguments: Record<string, unknown> }[] = [];
    const sandbox = await serveFetch(async (request) => {
      const body = (await request.json()) as { tool: string; arguments: Record<string, unknown> };
      calls.push(body);
      if (request.headers.get("accept") !== "application/x-ndjson")
        return Response.json({ text: "sandbox-only", exitCode: 0 });
      const lines = [
        ...(body.tool === "bash"
          ? [
              { type: "delta", text: "sandbox-" },
              { type: "delta", text: "only" },
            ]
          : []),
        { type: "result", text: "sandbox-only", exitCode: 0 },
      ];
      return new Response(lines.map((line) => `${JSON.stringify(line)}\n`).join(""), {
        headers: { "content-type": "application/x-ndjson" },
      });
    });
    const seen: string[] = [];
    const gateway = createModelGateway(() => ({
      primary: aiSDKModel(
        new MockLanguageModelV4({
          doStream: async ({ prompt, tools }) => {
            const lastUser = prompt.findLastIndex((message) => message.role === "user");
            const toolResults = prompt.slice(lastUser + 1).filter((m) => m.role === "tool");
            seen.push(JSON.stringify(toolResults));
            const definitions = tools?.filter((tool) => tool.type === "function") ?? [];
            const external = (name: string) =>
              definitions.find((tool) => tool.name === name || tool.name.endsWith(`__${name}`));
            const claude = harness === "claude-code";
            const file = claude
              ? { file_path: "/workspace/proof.txt" }
              : { filePath: "/workspace/proof.txt" };
            const steps = [
              { name: external("write")?.name, input: { ...file, content: "before-edit" } },
              {
                name: external("edit")?.name,
                input: claude
                  ? { ...file, old_string: "before-edit", new_string: "sandbox-only" }
                  : { ...file, oldString: "before-edit", newString: "sandbox-only" },
              },
              { name: external("read")?.name, input: { ...file } },
              {
                name: external("bash")?.name,
                input: { command: "cat /workspace/proof.txt", description: "Verify" },
              },
            ];
            const step = steps[toolResults.length];
            if (step && !step.name) throw new Error("Native workspace tool is missing");
            return {
              stream: simulateReadableStream({
                chunks: [
                  { type: "stream-start", warnings: [] },
                  ...(step
                    ? [
                        {
                          type: "tool-call" as const,
                          toolCallId: `call_${crypto.randomUUID().replaceAll("-", "")}`,
                          toolName: step.name ?? "missing",
                          input: JSON.stringify(step.input),
                        },
                      ]
                    : [
                        { type: "text-start" as const, id: "answer" },
                        { type: "text-delta" as const, id: "answer", delta: "Done." },
                        { type: "text-end" as const, id: "answer" },
                      ]),
                  {
                    type: "finish",
                    finishReason: { unified: step ? "tool-calls" : "stop", raw: undefined },
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
      sandboxUrl: sandbox.url,
      supervisorUrl: server.url,
      diagnostics: (line) => diagnostics.push(line),
    });
    const execution: Execution = {
      sessionId: "sess_workspace",
      turnId: "turn_workspace",
      generation: 1,
      harness,
      model: "primary",
      agent: { model: "primary" },
      input: [{ role: "user", content: [{ type: "input_text", text: "Write the proof." }] }],
      checkpoint: null,
      deadline: Date.now() + 50_000,
      sandbox: true,
    };
    const events: RuntimeEvent[] = [];
    try {
      const response = await fetch(`${server.url}/jobs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ execution, operationId: "start" }),
      });
      expect(response.ok, await response.text()).toBe(true);
      let done = false;
      let cursor = 0;
      for (let attempt = 0; attempt < 600; attempt++) {
        const batch = (await (
          await fetch(`${server.url}/jobs/${execution.turnId}?after=${cursor}`)
        ).json()) as RuntimeBatch;
        for (const { seq, event } of batch.events) {
          cursor = seq;
          events.push(event);
        }
        expect(batch.status, `${batch.error}\n${diagnostics.join("\n")}`).not.toBe("failed");
        if (batch.status === "completed") {
          done = true;
          break;
        }
        await delay(50);
      }
      expect(done, diagnostics.join("\n")).toBe(true);
      expect(calls.map((call) => call.tool)).toEqual(["write", "edit", "read", "bash"]);
      expect(calls[3]?.arguments).toMatchObject({ command: "cat /workspace/proof.txt" });
      // Every replacement tool handed the sandbox text back to the model unchanged.
      const last = JSON.parse(seen.at(-1) ?? "[]") as { content: unknown[] }[];
      expect(last).toHaveLength(4);
      for (const message of last) expect(JSON.stringify(message)).toContain("sandbox-only");
      expect(JSON.stringify(last)).not.toContain("Unrecognized key");
      expect(events.filter((event) => event.type === "command_delta")).toHaveLength(2);
      expect(events.find((event) => event.type === "command")).toMatchObject({
        command: "cat /workspace/proof.txt",
        output: "sandbox-only",
        exitCode: 0,
      });
    } finally {
      await supervisor.stop();
      await server.close();
      await model.close();
      await sandbox.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
