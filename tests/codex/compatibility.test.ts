import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { expect, it } from "vitest";

import { runPromise } from "../../packages/agent-api/src/index.js";
import { constrainCodexSearch } from "../../packages/agent-api/src/models/codex-search.js";
import type { Execution } from "../../packages/agent-api/src/runtime.js";
import { Buffer } from "../../packages/supervisor/src/buffer.js";
import { CodexJob } from "../../packages/supervisor/src/codex.js";

const imageUrl =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

it.each(["configured", "defaults"] as const)(
  "passes images, rich tool output and %s web settings through real Codex, and restores per-turn usage",
  async (settings) => {
    const directory = await mkdtemp(join(tmpdir(), "cf-codex-compat-"));
    const requests: Record<string, unknown>[] = [];
    const handle = async (request: IncomingMessage, response: ServerResponse) => {
      const chunks: Uint8Array[] = [];
      for await (const chunk of request) chunks.push(chunk as Uint8Array);
      // Apply the same egress correction as HarnessDO before the scripted provider.
      const body = constrainCodexSearch(
        JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>,
        "cached",
      );
      requests.push(body);
      response.writeHead(200, { "content-type": "text/event-stream" });
      const send = (type: string, data: object) =>
        response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      send("response.created", {
        response: {
          id: `resp_${requests.length}`,
          object: "response",
          status: "in_progress",
          output: [],
        },
      });
      const output: object[] = [];
      if (requests.length === 1) {
        const summary = { type: "summary_text", text: "Inspecting the supplied image." };
        send("response.output_item.added", {
          output_index: 0,
          item: { type: "reasoning", id: "rs_test", summary: [] },
        });
        send("response.reasoning_summary_part.added", {
          item_id: "rs_test",
          output_index: 0,
          summary_index: 0,
          part: { type: "summary_text", text: "" },
        });
        send("response.reasoning_summary_text.delta", {
          item_id: "rs_test",
          output_index: 0,
          summary_index: 0,
          delta: summary.text,
        });
        send("response.reasoning_summary_text.done", {
          item_id: "rs_test",
          output_index: 0,
          summary_index: 0,
          text: summary.text,
        });
        send("response.reasoning_summary_part.done", {
          item_id: "rs_test",
          output_index: 0,
          summary_index: 0,
          part: summary,
        });
        output.push({ type: "reasoning", id: "rs_test", summary: [summary] });
        send("response.output_item.done", { output_index: 0, item: output[0] });
        const search = {
          type: "web_search_call",
          id: "web_test",
          status: "completed",
          action: { type: "search", query: "fixture-only", queries: ["fixture-only"] },
        };
        send("response.output_item.added", {
          output_index: 1,
          item: { ...search, status: "in_progress" },
        });
        send("response.output_item.done", { output_index: 1, item: search });
        output.push(search);
        const call = {
          type: "function_call",
          id: "fc_test",
          call_id: "lookup",
          name: "lookup",
          arguments: '{"query":"image"}',
        };
        send("response.output_item.done", { output_index: 2, item: call });
        output.push(call);
      } else {
        const message = {
          type: "message",
          id: `msg_${requests.length}`,
          role: "assistant",
          content: [{ type: "output_text", text: "Image checked." }],
        };
        output.push(message);
        send("response.output_item.done", { output_index: 0, item: message });
      }
      send("response.completed", {
        response: {
          id: `resp_${requests.length}`,
          object: "response",
          status: "completed",
          output,
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            total_tokens: 15,
            input_tokens_details: { cached_tokens: 2 },
            output_tokens_details: { reasoning_tokens: 3 },
          },
        },
      });
      response.end();
    };
    const server = createServer((request, response) => {
      void handle(request, response);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing provider address");
    const execution: Execution = {
      sessionId: "sess_compat",
      turnId: "turn_compat",
      generation: 1,
      harness: "codex",
      model: "search-fixture",
      agent: {
        model: "codex",
        reasoning: { summary: "detailed" },
        tools: [
          {
            type: "function",
            name: "lookup",
            description: "Lookup image",
            parameters: {
              type: "object",
              properties: { query: { type: "string" } },
              required: ["query"],
              additionalProperties: false,
            },
          },
          {
            type: "web_search",
            mode: "cached",
            ...(settings === "configured"
              ? {
                  context_size: "low" as const,
                  allowed_domains: ["example.org"],
                  location: { country: "JP", city: "Tokyo", region: null, timezone: null },
                }
              : { context_size: null, allowed_domains: null, location: null }),
          },
        ],
      },
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "Inspect this image." },
            { type: "input_image", image_url: imageUrl },
          ],
        },
      ],
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
      await runPromise(job.start()).catch((error: unknown) => {
        throw new Error(diagnostics.join("\n"), { cause: error });
      });
      await expect.poll(async () => (await runPromise(job.poll(0))).status).toBe("waiting");
      await runPromise(
        job.control("result", {
          type: "tool_result",
          callId: "lookup",
          success: true,
          output: [
            { type: "input_text", text: "Image tool result" },
            { type: "input_image", image_url: imageUrl },
          ],
        }),
      );
      for (
        let i = 0;
        i < 300 && ["running", "waiting"].includes((await runPromise(job.poll(0))).status);
        i++
      )
        await delay(20);
      const batch = await runPromise(job.poll(0));
      expect(batch.status, diagnostics.join("\n")).toBe("completed");
      const events = batch.events.map(({ event }) => event);
      expect(events.find((event) => event.type === "reasoning_delta")).toMatchObject({
        summaryIndex: 0,
        text: "Inspecting the supplied image.",
      });
      expect(
        events.find((event) => event.type === "reasoning" && event.status === "completed"),
      ).toMatchObject({ summary: ["Inspecting the supplied image."] });
      expect(
        events.find((event) => event.type === "web_search" && event.status === "completed"),
      ).toMatchObject({ action: { type: "search", query: "fixture-only" } });
      expect(events.filter((event) => event.type === "usage").at(-1)).toMatchObject({
        usage: {
          input_tokens: 20,
          output_tokens: 10,
          total_tokens: 30,
          input_tokens_details: { cached_tokens: 4 },
          output_tokens_details: { reasoning_tokens: 6 },
        },
      });
      expect(JSON.stringify(requests[0]?.input)).toContain(imageUrl);
      expect(JSON.stringify(requests[1]?.input)).toContain("Image tool result");
      expect(JSON.stringify(requests[1]?.input).split(imageUrl).length).toBeGreaterThanOrEqual(3);
      const search = ((requests[0]?.tools ?? []) as { type: string }[]).find(
        (tool) => tool.type === "web_search",
      );
      expect(search).toMatchObject({
        type: "web_search",
        external_web_access: false,
        search_context_size: settings === "configured" ? "low" : "medium",
        ...(settings === "configured"
          ? {
              filters: { allowed_domains: ["example.org"] },
              user_location: { country: "JP", city: "Tokyo" },
            }
          : {}),
      });
      const bundle = await runPromise(job.checkpoint());
      await rm(job.home, { recursive: true, force: true });
      resumed = new CodexJob(
        {
          ...execution,
          generation: 2,
          turnId: "turn_resumed",
          input: [{ role: "user", content: [{ type: "input_text", text: "Continue." }] }],
        },
        options,
      );
      await runPromise(resumed.start(bundle));
      for (let i = 0; i < 300 && (await runPromise(resumed.poll(0))).status === "running"; i++)
        await delay(20);
      expect((await runPromise(resumed.poll(0))).status, diagnostics.join("\n")).toBe("completed");
      expect(
        (await runPromise(resumed.poll(0))).events
          .filter(({ event }) => event.type === "usage")
          .at(-1)?.event,
      ).toMatchObject({ usage: { total_tokens: 15 } });
      expect(JSON.stringify(requests.at(-1)?.input)).toContain("Image tool result");
    } finally {
      if (resumed) await runPromise(resumed.stop());
      await runPromise(job.stop());
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  },
);
