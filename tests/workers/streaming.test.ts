/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { reset, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import OpenAI from "openai";
import { afterEach, expect, it } from "vitest";

import type { RuntimeEvent } from "../../packages/agent-api/src/runtime.js";
import type * as WorkerModule from "./worker.js";
import type { SessionDO, TestEnv } from "./worker.js";

declare global {
  namespace Cloudflare {
    interface Env extends TestEnv {}
    interface GlobalProps {
      mainModule: typeof WorkerModule;
    }
  }
}
const tenant = "streaming";
const api = new OpenAI({
  apiKey: tenant,
  baseURL: "https://api.test/v1",
  maxRetries: 0,
  fetch: (input, init) => exports.default.fetch(new Request(input, init)),
});
const params = { agent: { model: "test" }, environment: { type: "none" as const } };
const stub = (id: string) => env.SESSIONS.getByName(JSON.stringify([tenant, id]));
afterEach(() => reset());

it("a cancelled stream returns its listener permit", async () => {
  const session = await api.beta.agents.sessions.create(params);
  const result = await runInDurableObject<SessionDO, unknown>(
    stub(session.id),
    async (instance) => {
      const responses: Response[] = [];
      for (let i = 0; i < 64; i++) {
        responses.push(instance.stream());
        // The stream's fiber takes its permit on the next task, as it does between RPC calls.
        await Promise.resolve();
      }
      let limited: unknown;
      try {
        instance.stream();
      } catch (error) {
        limited = error;
      }
      const started = Date.now();
      await responses[0]?.body?.cancel();
      const cancelMs = Date.now() - started;
      const again = instance.stream();
      for (const response of [again, ...responses.slice(1)]) await response.body?.cancel();
      return {
        limited: (limited as { _tag?: string } | undefined)?._tag,
        cancelMs,
        again: again.status,
      };
    },
  );
  expect(result).toMatchObject({ limited: "StreamLimitExceeded", again: 200 });
  expect((result as { cancelMs: number }).cancelMs).toBeLessThan(1_000);
});

const message = (text: string) => ({
  type: "agent.session.input.message" as const,
  input: [{ role: "user" as const, content: [{ type: "input_text" as const, text }] }],
});
/** Read SSE frames until one satisfies `wanted`; fails after `timeoutMs`. */
async function frameMatching(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  wanted: (frame: string) => boolean,
  timeoutMs: number,
): Promise<{ frame: string; ms: number }> {
  const started = Date.now();
  const decoder = new TextDecoder();
  for (;;) {
    const remaining = timeoutMs - (Date.now() - started);
    if (remaining <= 0) throw new Error("No matching frame arrived in time");
    const chunk = await Promise.race([
      reader.read(),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error("Stream read timed out")), remaining),
      ),
    ]);
    if (chunk.done) throw new Error("Stream ended before the frame arrived");
    const frame = decoder.decode(chunk.value);
    if (wanted(frame)) return { frame, ms: Date.now() - started };
  }
}

it("streaming latency follows the driver's long poll, not the alarm interval", async () => {
  // The test deployment polls every 60 s; every delta below must arrive far sooner, and
  // the whole turn completes inside the one alarm this test runs.
  const session = await api.beta.agents.sessions.create({
    ...params,
    agent: { model: "test-longpoll" },
  });
  const result = await runInDurableObject<SessionDO, unknown>(
    stub(session.id),
    async (instance) => {
      await instance.submit([message("long-poll")], "initial");
      const turn = instance.turns({ order: "asc", limit: 1 }).data[0];
      if (!turn) throw new Error("Missing turn");
      const harness = env.SCRIPTED.getByName(turn.id);
      const body = instance.stream().body as ReadableStream<Uint8Array> | null;
      const reader = body?.getReader();
      if (!reader) throw new Error("Missing stream body");
      const tick = instance.alarm();
      const delta = (text: string) => (frame: string) =>
        frame.includes("agent.session.turn.output_text.delta") && frame.includes(`"${text}"`);
      const push = (event: RuntimeEvent | null) => harness.push(event);
      const latencies: number[] = [];
      for (const text of ["one", "two", "three"]) {
        // Let the reconciler's poll settle into its wait before the event arrives.
        await new Promise((resolve) => setTimeout(resolve, 50));
        await push({ type: "delta", id: "answer", text });
        latencies.push((await frameMatching(reader, delta(text), 5_000)).ms);
      }
      await push({ type: "text", id: "answer", text: "onetwothree", phase: "final_answer" });
      await push(null);
      const idle = await frameMatching(
        reader,
        (frame) => frame.includes("agent.session.idle"),
        5_000,
      );
      await tick;
      await reader.cancel();
      return { latencies, idleMs: idle.ms, status: instance.retrieve().status };
    },
  );
  const { latencies, idleMs } = result as { latencies: number[]; idleMs: number };
  expect(result).toMatchObject({ status: "idle" });
  expect(latencies).toHaveLength(3);
  for (const ms of [...latencies, idleMs]) expect(ms).toBeLessThan(2_000);
});
