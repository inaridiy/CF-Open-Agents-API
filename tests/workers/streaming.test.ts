/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { reset, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import OpenAI from "openai";
import { afterEach, expect, it } from "vitest";

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
        limited: (limited as { code?: string } | undefined)?.code,
        cancelMs,
        again: again.status,
      };
    },
  );
  expect(result).toMatchObject({ limited: "stream_limit", again: 200 });
  expect((result as { cancelMs: number }).cancelMs).toBeLessThan(1_000);
});
