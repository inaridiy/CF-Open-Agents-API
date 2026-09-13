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
  apiKey: "recovery-contracts",
  baseURL: "https://api.test/v1",
  maxRetries: 0,
  fetch: (input, init) => exports.default.fetch(new Request(input, init)),
});
const parameters = { agent: { model: "test" }, environment: { type: "none" as const } };
afterEach(() => reset());
it.each([false, true])(
  "cancel with late tool results recovers its native outcome (lost response: %s)",
  async (loseResponse) => {
    const session = await api.beta.agents.sessions.create(parameters);
    const result = await runInDurableObject<SessionDO, unknown>(
      env.SESSIONS.getByName(JSON.stringify(["recovery-contracts", session.id])),
      async (instance) => {
        let cancelled = false;
        let polls = 0;
        const driver = fromPromiseDriver({
          name: "fixture",
          revision: "test-v1",
          capabilities: { steer: true, functions: true, sandbox: false },
          start: async () => {},
          stop: async () => {},
          control: async (_execution, _id, command) => {
            if (command.type === "cancel") {
              cancelled = true;
              if (loseResponse) throw new Error("Lost cancellation response");
              return;
            }
            if (cancelled) throw new Error("Execution is not waiting for tools");
          },
          poll: async () => {
            polls++;
            return {
              status: cancelled ? "cancelled" : "waiting",
              cursor: 1,
              events: [
                {
                  seq: 1,
                  event: {
                    type: "function_call",
                    id: "call",
                    callId: "call",
                    name: "lookup",
                    arguments: {},
                  },
                },
              ],
            };
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
        await instance.submit(
          [
            {
              type: "agent.session.input.message",
              input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
            },
          ],
          "initial",
        );
        await instance.alarm();
        const turn = instance.turns({ order: "asc", limit: 1 }).data[0];
        if (!turn) throw new Error("Missing turn");
        const accepted = await instance.submit(
          [
            { type: "agent.session.input.cancel" },
            {
              type: "agent.session.input.tool_result",
              call_id: "call",
              turn_id: turn.id,
              success: true,
              output: "result",
            },
          ],
          "cancel-and-late-result",
        );
        await instance.alarm();
        const afterCancel = {
          status: instance.retrieve().status,
          polls,
          pending: instance.db.list("command", { order: "asc", limit: 100 }).data.length,
        };
        const state = instance.db.require<SessionRecord>("state", "session");
        if (state.execution)
          instance.db.put("state", "session", {
            ...state,
            execution: { ...state.execution, deadline: Date.now() - 1 },
          });
        await instance.alarm();
        return {
          accepted,
          afterCancel,
          final: instance.retrieve().status,
          turn: instance.turn(turn.id).status,
        };
      },
    );
    expect(result).toMatchObject({
      accepted: { ok: true },
      afterCancel: { status: "idle", pending: 0 },
      final: "idle",
      turn: "cancelled",
    });
  },
);
it("session creation retry survives deletion of its saved agent", async () => {
  const agent = await api.beta.agents.create({ model: "test" });
  const params = { agent_id: agent.id, environment: { type: "none" as const } };
  const opts = { headers: { "Idempotency-Key": "saved-agent-retry" } };
  const session = await api.beta.agents.sessions.create(params, opts);
  await api.beta.agents.delete(agent.id);
  const retry = await api.beta.agents.sessions.create(params, opts).then(
    (value) => ({ status: 200, id: value.id }),
    (error: { status: number }) => ({ status: error.status }),
  );
  expect(retry).toEqual({ status: 200, id: session.id });
});
