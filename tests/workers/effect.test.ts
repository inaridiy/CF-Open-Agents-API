/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { reset, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import OpenAI from "openai";
import { afterEach, expect, it } from "vitest";

import { fromPromiseDriver } from "../../packages/agent-api/src/runtime.js";
import type { SessionRecord } from "../../packages/agent-api/src/session.js";
import type { SessionDO, TestEnv } from "./worker.js";

declare global {
  namespace Cloudflare {
    interface Env extends TestEnv {}
  }
}
const api = new OpenAI({
  apiKey: "effect",
  baseURL: "https://api.test/v1",
  maxRetries: 0,
  fetch: (input, init) => exports.default.fetch(new Request(input, init)),
});
const message = {
  type: "agent.session.input.message" as const,
  input: [{ role: "user" as const, content: [{ type: "input_text" as const, text: "hold" }] }],
};
afterEach(() => reset());

it("overlapping alarms share reconciliation while new input stays independently admissible", async () => {
  const session = await api.beta.agents.sessions.create({
    agent: { model: "test" },
    environment: { type: "none" },
  });
  const result = await runInDurableObject<SessionDO, unknown>(
    env.SESSIONS.getByName(JSON.stringify(["effect", session.id])),
    async (instance) => {
      let starts = 0;
      let polls = 0;
      let controls = 0;
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const driver = fromPromiseDriver({
        name: "fixture",
        revision: "test-v1",
        capabilities: { steer: true, functions: true, sandbox: false },
        start: async () => {
          starts++;
        },
        stop: async () => {},
        control: async () => {
          controls++;
        },
        poll: async () => {
          polls++;
          entered.resolve();
          await release.promise;
          return { status: "completed", cursor: 0, events: [] };
        },
        checkpoint: async () => ({
          version: 1,
          driver: "fixture",
          revision: "test-v1",
          native: "saved",
        }),
      });
      Object.defineProperty(instance, "dependencies", {
        value: () => ({ drivers: { fixture: driver }, maxTurnMs: 60000, pollIntervalMs: 60000 }),
      });
      await instance.submit([message], "initial");
      const first = instance.alarm();
      await entered.promise;
      await instance.alarm();
      const accepted = await instance.submit([message], "second");
      release.resolve();
      await first;
      return {
        starts,
        polls,
        controls,
        accepted,
        status: instance.retrieve().status,
        commands: instance.db.list("command", { order: "asc", limit: 100 }).data,
      };
    },
  );
  expect(result).toMatchObject({
    starts: 1,
    polls: 2,
    controls: 1,
    accepted: { ok: true },
    status: "idle",
    commands: [],
  });
});

it("a noncontiguous runtime batch rolls back every event and fails the turn at once", async () => {
  const session = await api.beta.agents.sessions.create({
    agent: { model: "test" },
    environment: { type: "none" },
  });
  const result = await runInDurableObject<SessionDO, unknown>(
    env.SESSIONS.getByName(JSON.stringify(["effect", session.id])),
    async (instance) => {
      let stops = 0;
      const driver = fromPromiseDriver({
        name: "fixture",
        revision: "test-v1",
        capabilities: { steer: true, functions: true, sandbox: false },
        start: async () => {},
        stop: async () => {
          stops++;
        },
        control: async () => {},
        poll: async () => ({
          status: "completed",
          cursor: 3,
          events: [
            { seq: 1, event: { type: "delta", id: "output", text: "partial" } },
            {
              seq: 3,
              event: {
                type: "text",
                id: "output",
                text: "invalid completion",
                phase: "final_answer",
              },
            },
          ],
        }),
        checkpoint: async () => {
          throw new Error("Must not checkpoint an invalid batch");
        },
      });
      Object.defineProperty(instance, "dependencies", {
        value: () => ({ drivers: { fixture: driver }, maxTurnMs: 60000, pollIntervalMs: 60000 }),
      });
      await instance.submit([message], "initial");
      await instance.alarm();
      const turn = instance.turns({ order: "asc", limit: 1 }).data[0];
      return {
        cursor: instance.db.require<SessionRecord>("state", "session").cursor,
        outputs: instance
          .items({ order: "asc", limit: 100 })
          .data.filter((item) => item.type === "message" && item.role === "assistant"),
        status: instance.retrieve().status,
        error: instance.retrieve().error,
        turn: { status: turn?.status, error: turn?.error },
        stops,
      };
    },
  );
  // The batch is rolled back atomically; a protocol violation then fails the turn on the
  // first occurrence and the session returns to idle instead of retrying until its deadline.
  expect(result).toEqual({
    cursor: 0,
    outputs: [],
    status: "idle",
    error: "invalid_runtime_cursor",
    turn: {
      status: "failed",
      error: { code: "internal_error", message: "invalid_runtime_cursor" },
    },
    stops: 1,
  });
});
