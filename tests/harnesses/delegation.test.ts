import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { expect, it } from "vitest";
import type {
  Execution,
  RuntimeBatch,
  RuntimeCommand,
  RuntimeEvent,
} from "../../packages/agent-api/src/index.js";
import { aiSDKModel, createModelGateway } from "../../packages/agent-api/src/models.js";
import { createSupervisor } from "../../packages/supervisor/src/server.js";
import { serveFetch } from "./http.js";

/** Scripted HarnessDO delegate route: one child that raises a client function call, then answers. */
function scriptedChildren() {
  const children = new Map<
    string,
    { events: { seq: number; event: RuntimeEvent }[]; status: RuntimeBatch["status"] }
  >();
  const controls: { subagentId: string; command: RuntimeCommand }[] = [];
  const spawns: unknown[] = [];
  const server = serveFetch(async (request) => {
    const url = new URL(request.url);
    const [turnId, target, action] = url.pathname.split("/").slice(1);
    expect(turnId).toBe("turn_parent");
    if (request.method === "POST" && target === "spawn") {
      const body = await request.json();
      spawns.push(body);
      const index = children.size;
      const subagentId = `subagent_${index + 1}`;
      children.set(subagentId, {
        status: "waiting",
        events: [
          {
            seq: 1,
            event: {
              type: "function_call",
              id: "child_call",
              callId: `call_child_${index + 1}`,
              name: "lookup",
              arguments: { query: "child" },
            },
          },
        ],
      });
      return Response.json({ subagentId, turnId: `turn_child_${index}` });
    }
    const child = target ? children.get(target) : undefined;
    if (!child) return new Response("unknown", { status: 404 });
    if (request.method === "POST" && action === "control") {
      const body = (await request.json()) as { command: RuntimeCommand };
      controls.push({ subagentId: target ?? "", command: body.command });
      if (body.command.type === "tool_result") {
        child.events.push({
          seq: child.events.length + 1,
          event: {
            type: "text",
            id: "child_answer",
            text: `CHILD_ANSWER:${JSON.stringify(body.command.output)}`,
            phase: "final_answer",
          },
        });
        child.status = "completed";
      }
      if (body.command.type === "cancel") child.status = "cancelled";
      return new Response(null, { status: 204 });
    }
    const after = Number(url.searchParams.get("after") ?? "0");
    return Response.json({
      events: child.events.filter((entry) => entry.seq > after),
      cursor: child.events.at(-1)?.seq ?? 0,
      status: child.status,
    } satisfies RuntimeBatch);
  });
  return { server, controls, spawns };
}

/**
 * Scripted parent model: delegates once, then either waits for the child (`wait`)
 * or answers immediately and leaves the child running (`leave`).
 */
function scriptedGateway(plan: "wait" | "leave") {
  return createModelGateway(() => ({
    primary: aiSDKModel(
      new MockLanguageModelV4({
        doStream: async ({ prompt, tools }) => {
          const history = JSON.stringify(prompt);
          const definitions = tools?.filter((tool) => tool.type === "function") ?? [];
          const find = (suffix: string) =>
            definitions.find((tool) => tool.name === suffix || tool.name.endsWith(`_${suffix}`));
          const spawned = history.includes("subagent_1");
          const waited = plan === "leave" || history.includes("CHILD_ANSWER");
          const tool = !spawned ? find("cf_delegate") : !waited ? find("cf_wait") : undefined;
          if (!waited && !tool)
            throw new Error(`Missing delegation tool: ${definitions.map((t) => t.name)}`);
          return {
            stream: simulateReadableStream({
              chunks: [
                { type: "stream-start", warnings: [] },
                ...(tool
                  ? [
                      {
                        type: "tool-call" as const,
                        toolCallId: `call_${crypto.randomUUID().replaceAll("-", "")}`,
                        toolName: tool.name,
                        input: JSON.stringify(
                          !spawned
                            ? { model: "helper", prompt: "CHILD_TASK", name: "checker" }
                            : { subagent_ids: ["subagent_1"] },
                        ),
                      },
                    ]
                  : [
                      { type: "text-start" as const, id: "answer" },
                      { type: "text-delta" as const, id: "answer", delta: "Delegation done." },
                      { type: "text-end" as const, id: "answer" },
                    ]),
                {
                  type: "finish",
                  finishReason: { unified: tool ? "tool-calls" : "stop", raw: "scripted" },
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
}
const harnesses = ["codex", "claude-code", "opencode"] as const;
const parentExecution = (harness: (typeof harnesses)[number]): Execution => ({
  sessionId: "sess_delegation",
  turnId: "turn_parent",
  generation: 1,
  harness,
  model: "primary",
  agent: {
    model: "primary",
    multi_agent: { enabled: true, max_concurrent_subagents: 2 },
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
  input: [{ role: "user", content: [{ type: "input_text", text: "Delegate the check." }] }],
  checkpoint: null,
  deadline: Date.now() + 50_000,
  sandbox: false,
  delegates: [{ alias: "helper", harness: "claude-code", model: "primary" }],
  maxConcurrentSubagents: 2,
});
const post = (url: string, path: string, body: unknown) =>
  fetch(url + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

it.each(harnesses)(
  "%s delegates to another runtime, routes the child's client tool result and waits for it",
  async (harness) => {
    const directory = await mkdtemp(join(tmpdir(), "cf-delegation-"));
    const diagnostics: string[] = [];
    const scripted = scriptedChildren();
    const delegate = await scripted.server;
    const gateway = scriptedGateway("wait");
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
      delegateUrl: delegate.url,
      diagnostics: (line) => diagnostics.push(line),
    });
    const execution = parentExecution(harness);
    const events: RuntimeEvent[] = [];
    try {
      const response = await fetch(`${server.url}/jobs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ execution, operationId: "start" }),
      });
      expect(response.ok, await response.text()).toBe(true);
      let status: RuntimeBatch["status"] = "running";
      let cursor = 0;
      for (let attempt = 0; attempt < 600 && !["completed", "failed"].includes(status); attempt++) {
        const batch = (await (
          await fetch(`${server.url}/jobs/${execution.turnId}?after=${cursor}`)
        ).json()) as RuntimeBatch;
        for (const { seq, event } of batch.events) {
          cursor = seq;
          events.push(event);
          if (event.type === "function_call" && event.subagentId) {
            // The child's client call surfaces with its own scope; the result routes back to it.
            expect(event.subagentId).toBe("subagent_1");
            expect(event.turnId).toBe("turn_child_0");
            const control = await fetch(`${server.url}/jobs/${execution.turnId}/control`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                operationId: event.callId,
                command: {
                  type: "tool_result",
                  callId: event.callId,
                  success: true,
                  output: "CLIENT_PROOF",
                },
              }),
            });
            expect(control.ok, await control.text()).toBe(true);
          }
        }
        status = batch.status;
        if (status === "failed") throw new Error(`${batch.error}\n${diagnostics.join("\n")}`);
        await delay(50);
      }
      expect(status, diagnostics.join("\n")).toBe("completed");
      expect(scripted.spawns).toEqual([{ alias: "helper", prompt: "CHILD_TASK", name: "checker" }]);
      expect(scripted.controls).toEqual([
        {
          subagentId: "subagent_1",
          command: {
            type: "tool_result",
            callId: "call_child_1",
            success: true,
            output: "CLIENT_PROOF",
          },
        },
      ]);
      const types = events.map((event) =>
        event.type === "collaboration" ? `collaboration:${event.operation}` : event.type,
      );
      expect(types.filter((type) => type.startsWith("collaboration"))).toEqual([
        "collaboration:spawnAgent",
        "collaboration:wait",
      ]);
      const subagent = events.filter((event) => event.type === "subagent");
      expect(subagent.map((event) => event.type === "subagent" && event.status)).toEqual([
        "active",
        "closed",
      ]);
      expect(subagent[0]).toMatchObject({ name: "checker", instructions: "CHILD_TASK" });
      const turns = events.filter((event) => event.type === "subagent_turn");
      expect(turns.map((event) => event.type === "subagent_turn" && event.status)).toEqual([
        "in_progress",
        "completed",
      ]);
      // Child output is scoped to the child turn and reaches the parent through cf_wait.
      const childText = events.find(
        (event) => event.type === "text" && event.subagentId === "subagent_1",
      );
      expect(childText).toMatchObject({
        text: 'CHILD_ANSWER:"CLIENT_PROOF"',
        turnId: "turn_child_0",
      });
      const parentText = events.find((event) => event.type === "text" && !event.subagentId);
      expect(parentText).toMatchObject({ text: "Delegation done." });
      expect(events.indexOf(childText as RuntimeEvent)).toBeLessThan(
        events.indexOf(parentText as RuntimeEvent),
      );
    } finally {
      await supervisor.stop();
      await server.close();
      await model.close();
      await delegate.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it.each(harnesses)(
  "%s cancels a parent whose root finished while a delegated child is still running",
  async (harness) => {
    const directory = await mkdtemp(join(tmpdir(), "cf-delegation-cancel-"));
    const diagnostics: string[] = [];
    const scripted = scriptedChildren();
    const delegate = await scripted.server;
    const gateway = scriptedGateway("leave");
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
      delegateUrl: delegate.url,
      diagnostics: (line) => diagnostics.push(line),
    });
    const execution = parentExecution(harness);
    const events: RuntimeEvent[] = [];
    const read = async () => {
      const batch = (await (
        await fetch(`${server.url}/jobs/${execution.turnId}?after=${events.length}`)
      ).json()) as RuntimeBatch;
      events.push(...batch.events.map(({ event }) => event));
      return batch;
    };
    try {
      const response = await post(server.url, "/jobs", { execution, operationId: "start" });
      expect(response.ok, await response.text()).toBe(true);
      // The root answers without waiting; the child keeps the turn open.
      let status: RuntimeBatch["status"] = "running";
      for (let attempt = 0; attempt < 600; attempt++) {
        status = (await read()).status;
        if (status === "failed") throw new Error(diagnostics.join("\n"));
        if (events.some((event) => event.type === "text" && !event.subagentId)) break;
        await delay(50);
      }
      expect(events.some((event) => event.type === "text" && !event.subagentId)).toBe(true);
      await delay(200);
      expect((await read()).status, diagnostics.join("\n")).toBe("running");
      const cancel = await post(server.url, `/jobs/${execution.turnId}/control`, {
        operationId: "cancel",
        command: { type: "cancel" },
      });
      expect(cancel.status, await cancel.text()).toBe(204);
      for (let attempt = 0; attempt < 200 && status === "running"; attempt++) {
        status = (await read()).status;
        await delay(25);
      }
      // A cancelled turn is never sealed as completed, and the child's end is recorded.
      expect(status, diagnostics.join("\n")).toBe("cancelled");
      expect(scripted.controls.map(({ command }) => command.type)).toEqual(["cancel"]);
      expect(
        events.some((event) => event.type === "subagent_turn" && event.status === "cancelled"),
      ).toBe(true);
      expect(events.some((event) => event.type === "subagent" && event.status === "closed")).toBe(
        true,
      );
    } finally {
      await supervisor.stop();
      await server.close();
      await model.close();
      await delegate.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
