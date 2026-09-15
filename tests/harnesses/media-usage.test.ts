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
import { Buffer } from "../../packages/supervisor/src/buffer.js";
import { createSupervisor } from "../../packages/supervisor/src/server.js";
import { serveFetch } from "./http.js";

const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
it.each<HarnessName>(["codex", "claude-code", "opencode"])(
  "%s preserves images, visible reasoning and per-turn cache usage across restore",
  async (harness) => {
    const directory = await mkdtemp(join(tmpdir(), "cf-media-"));
    const diagnostics: string[] = [];
    let imageRequests = 0;
    const gateway = createModelGateway(() => ({
      primary: aiSDKModel(
        new MockLanguageModelV4({
          doStream: async ({ prompt, tools }) => {
            const history = JSON.stringify(prompt);
            expect(
              prompt.some(
                (message) =>
                  message.role === "user" &&
                  message.content.some(
                    (part) => part.type === "file" && part.mediaType === "image/png",
                  ),
              ),
            ).toBe(true);
            const received = history.includes("image-result");
            const tool = tools?.find(
              (candidate) =>
                candidate.type === "function" &&
                (candidate.name === "lookup" || candidate.name.endsWith("function_0")),
            );
            if (!tool) throw new Error("Missing function tool");
            return {
              stream: simulateReadableStream({
                chunks: [
                  { type: "stream-start", warnings: [] },
                  { type: "reasoning-start", id: "reason" },
                  { type: "reasoning-delta", id: "reason", delta: "Checking the image." },
                  { type: "reasoning-end", id: "reason" },
                  ...(received
                    ? [
                        { type: "text-start" as const, id: "answer" },
                        { type: "text-delta" as const, id: "answer", delta: "Image verified." },
                        { type: "text-end" as const, id: "answer" },
                      ]
                    : [
                        {
                          type: "tool-call" as const,
                          toolCallId: `call_${crypto.randomUUID().replaceAll("-", "")}`,
                          toolName: tool.name,
                          input: "{}",
                        },
                      ]),
                  {
                    type: "finish",
                    finishReason: { unified: received ? "stop" : "tool-calls", raw: "scripted" },
                    usage: {
                      inputTokens: { total: 17, noCache: 10, cacheRead: 5, cacheWrite: 2 },
                      outputTokens: { total: 7, text: 4, reasoning: 3 },
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
    const media = await serveFetch(async (request) => {
      expect(new URL(request.url).searchParams.get("url")).toBe("https://image.fixture/proof.png");
      imageRequests++;
      return new Response(Buffer.from(png, "base64"), { headers: { "content-type": "image/png" } });
    });
    let supervisor: ReturnType<typeof createSupervisor>;
    const server = await serveFetch(async (request) => supervisor.app.fetch(request));
    const options = {
      binary: "codex",
      opencodeBinary: resolve("node_modules/.bin/opencode"),
      directory,
      modelBaseUrl: `${model.url}/v1`,
      sandboxUrl: "http://unused.invalid",
      supervisorUrl: server.url,
      mediaUrl: media.url,
      diagnostics: (line: string) => diagnostics.push(line),
    };
    supervisor = createSupervisor(options);
    const execution: Execution = {
      sessionId: "sess_media",
      turnId: "turn_first",
      generation: 1,
      harness,
      model: "primary",
      agent: {
        model: "primary",
        reasoning: { effort: "high", summary: "concise" },
        tools: [
          {
            type: "function",
            name: "lookup",
            description: "Get an image",
            parameters: { type: "object", properties: {}, additionalProperties: false },
          },
        ],
      },
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "Inspect the image." },
            { type: "input_image", image_url: `data:image/png;base64,${png}` },
          ],
        },
      ],
      checkpoint: null,
      deadline: Date.now() + 50_000,
      sandbox: false,
    };
    const post = async (path: string, body: unknown) => {
      const response = await fetch(server.url + path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(response.ok, `${await response.text()}\n${diagnostics.join("\n")}`).toBe(true);
    };
    const complete = async (turn: string) => {
      const replied = new Set<string>();
      for (let attempt = 0; attempt < 500; attempt++) {
        const batch = (await (await fetch(`${server.url}/jobs/${turn}`)).json()) as RuntimeBatch;
        expect(batch.status, `${batch.error}\n${diagnostics.join("\n")}`).not.toBe("failed");
        for (const { event } of batch.events)
          if (event.type === "function_call" && !replied.has(event.callId)) {
            replied.add(event.callId);
            await post(`/jobs/${turn}/control`, {
              operationId: event.callId,
              command: {
                type: "tool_result",
                callId: event.callId,
                success: true,
                output: [
                  { type: "input_text", text: "image-result" },
                  {
                    type: "input_image",
                    image_url:
                      harness === "codex"
                        ? `data:image/png;base64,${png}`
                        : "https://image.fixture/proof.png",
                  },
                ],
              },
            });
          }
        if (batch.status === "completed") return batch;
        await delay(50);
      }
      throw new Error(`Image turn timed out\n${diagnostics.join("\n")}`);
    };
    try {
      await post("/jobs", { execution, operationId: "first" });
      const first = await complete(execution.turnId);
      expect(
        first.events.some(
          ({ event }) =>
            event.type === "reasoning" &&
            event.status === "completed" &&
            event.summary.join("").includes("Checking the image."),
        ),
      ).toBe(true);
      expect(first.events.findLast(({ event }) => event.type === "usage")?.event).toMatchObject({
        usage: {
          input_tokens: 34,
          output_tokens: 14,
          total_tokens: 48,
          input_tokens_details: { cached_tokens: 10 },
        },
      });
      const checkpoint = await (
        await fetch(`${server.url}/jobs/${execution.turnId}/checkpoint`)
      ).json();
      await supervisor.stop();
      await rm(directory, { recursive: true, force: true });
      await mkdir(directory);
      supervisor = createSupervisor(options);
      const resumed = {
        ...execution,
        turnId: "turn_second",
        generation: 2,
        input: [{ role: "user", content: [{ type: "input_text", text: "Check again." }] }],
        checkpoint: {
          version: 1,
          driver: harness,
          revision: HARNESSES[harness].revision,
          native: "fixture.json",
        },
      };
      await post("/jobs", { execution: resumed, checkpoint, operationId: "second" });
      const second = await complete(resumed.turnId);
      expect(second.events.findLast(({ event }) => event.type === "usage")?.event).toMatchObject({
        usage: {
          input_tokens: 17,
          output_tokens: 7,
          total_tokens: 24,
          input_tokens_details: { cached_tokens: 5 },
        },
      });
      if (harness !== "codex") expect(imageRequests).toBe(1);
    } finally {
      await supervisor.stop();
      await server.close();
      await model.close();
      await media.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
