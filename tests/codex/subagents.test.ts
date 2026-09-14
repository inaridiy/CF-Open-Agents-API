import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { expect, it } from "vitest";

import type { Execution } from "../../packages/agent-api/src/runtime.js";
import { CodexJob } from "../../packages/supervisor/src/codex.js";

it.each(["complete", "cancel", "immediate"])(
  "keeps child output separate while the root finishes, then %s",
  async (outcome) => {
    const directory = await mkdtemp(join(tmpdir(), "cf-codex-children-"));
    const requests: Record<string, unknown>[] = [];
    let releaseChild: (() => void) | undefined;
    const childReady = new Promise<void>((resolve) => {
      releaseChild = resolve;
    });
    let searched = false;
    let spawned = false;
    const handle = async (request: IncomingMessage, response: ServerResponse) => {
      const chunks: Uint8Array[] = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
      requests.push(body);
      const input = body.input as { role?: string; content?: { text?: string }[] }[];
      const child = input.some(
        (item) => item.role === "user" && item.content?.some((part) => part.text === "CHILD_ONLY"),
      );
      let output: object[];
      if (child) {
        if (outcome !== "immediate") await childReady;
        output = [
          {
            type: "message",
            id: "child_message",
            role: "assistant",
            content: [{ type: "output_text", text: "child result" }],
          },
        ];
      } else if (!searched) {
        searched = true;
        output = [
          {
            type: "tool_search_call",
            id: "search_call",
            call_id: "search_call",
            execution: "client",
            arguments: { query: "spawn_agent", limit: 1 },
          },
        ];
      } else if (!spawned) {
        spawned = true;
        output = [
          {
            type: "function_call",
            id: "spawn_call",
            call_id: "spawn_call",
            namespace: "multi_agent_v1",
            name: "spawn_agent",
            arguments: JSON.stringify({ message: "CHILD_ONLY" }),
          },
        ];
      } else
        output = [
          {
            type: "message",
            id: "root_message",
            role: "assistant",
            content: [{ type: "output_text", text: "root result" }],
          },
        ];
      response.writeHead(200, { "content-type": "text/event-stream" });
      const send = (type: string, value: object) =>
        response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
      send("response.created", {
        response: { id: "response", object: "response", status: "in_progress", output: [] },
      });
      for (const [output_index, item] of output.entries()) {
        send("response.output_item.added", { output_index, item });
        send("response.output_item.done", { output_index, item });
      }
      send("response.completed", {
        response: {
          id: "response",
          object: "response",
          status: "completed",
          output,
          usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 },
        },
      });
      response.end();
    };
    const server = createServer((request, response) => {
      void handle(request, response);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing provider port");
    const execution: Execution = {
      sessionId: "sess_children",
      turnId: "turn_children",
      generation: 1,
      harness: "codex",
      model: "gpt-5.4",
      agent: {
        model: "coding",
        multi_agent: { enabled: true, max_concurrent_subagents: 2 },
        reasoning: { effort: "high" },
        text: { verbosity: "low" },
      },
      input: [{ role: "user", content: [{ type: "input_text", text: "Spawn a child." }] }],
      checkpoint: null,
      deadline: Date.now() + 60_000,
      sandbox: false,
    };
    const diagnostics: string[] = [];
    const options = {
      binary: "codex",
      directory,
      modelBaseUrl: `http://127.0.0.1:${address.port}/v1`,
      sandboxUrl: "ws://unused",
      diagnostics: (line: string) => {
        diagnostics.push(line);
      },
    };
    const job = new CodexJob(execution, options);
    let resumed: CodexJob | undefined;
    try {
      await job.start();
      for (
        let i = 0;
        i < 200 &&
        !job
          .poll(0)
          .events.some(({ event }) => event.type === "text" && event.text === "root result");
        i++
      )
        await delay(25);
      if (outcome !== "immediate")
        expect(job.poll(0).status, diagnostics.join("\n")).toBe("running");
      // The child's turn notification and the root's final text are independent
      // app-server events; the child turn is asserted once it has been projected.
      const childTurnSeen = () =>
        job.poll(0).events.some(({ event }) => event.type === "subagent_turn");
      for (let i = 0; i < 200 && !childTurnSeen(); i++) await delay(25);
      expect(childTurnSeen(), diagnostics.join("\n")).toBe(true);
      if (outcome === "cancel") {
        await job.control("cancel-after-root", { type: "cancel" });
        for (let i = 0; i < 200 && job.poll(0).status === "running"; i++) await delay(25);
        expect(job.poll(0).status, diagnostics.join("\n")).toBe("cancelled");
        expect(
          job
            .poll(0)
            .events.some(
              ({ event }) => event.type === "subagent_turn" && event.status === "cancelled",
            ),
        ).toBe(true);
        return;
      }
      releaseChild?.();
      for (let i = 0; i < 200 && job.poll(0).status === "running"; i++) await delay(25);
      const batch = job.poll(0);
      expect(batch.status, diagnostics.join("\n")).toBe("completed");
      expect(
        batch.events.some(
          ({ event }) => event.type === "collaboration" && event.operation === "spawnAgent",
        ),
      ).toBe(true);
      const child = batch.events.find(({ event }) => event.type === "subagent")?.event;
      if (child?.type !== "subagent") throw new Error("Missing child");
      const childTurn = batch.events.find(({ event }) => event.type === "subagent_turn")?.event;
      if (childTurn?.type !== "subagent_turn") throw new Error("Missing child turn");
      expect(
        batch.events.find(({ event }) => event.type === "usage" && event.subagentId === child.id)
          ?.event,
      ).toMatchObject({ turnId: childTurn.id, usage: { total_tokens: 13 } });
      expect(
        batch.events.find(({ event }) => event.type === "text" && event.text === "child result")
          ?.event,
      ).toMatchObject({ subagentId: child.id });
      expect(requests[0]?.reasoning).toMatchObject({ effort: "high" });
      const bundle = await job.checkpoint();
      expect(bundle.files["cf-subagents.json"]).toBeDefined();
      await rm(job.home, { recursive: true, force: true });
      resumed = new CodexJob(
        {
          ...execution,
          turnId: "turn_resumed",
          generation: 2,
          input: [
            { role: "user", content: [{ type: "input_text", text: "Continue the conversation." }] },
          ],
        },
        options,
      );
      await resumed.start(bundle);
      for (let i = 0; i < 200 && resumed.poll(0).status === "running"; i++) await delay(25);
      expect(resumed.poll(0).status, diagnostics.join("\n")).toBe("completed");
      expect(JSON.stringify(requests.at(-1)?.input)).toContain("spawn_agent");
    } finally {
      releaseChild?.();
      await resumed?.stop();
      await job.stop();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  },
);
