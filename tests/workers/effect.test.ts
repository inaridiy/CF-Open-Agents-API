/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { reset, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { Effect, Schema } from "effect";
import OpenAI from "openai";
import { afterEach, expect, it } from "vitest";

import { OperationError, runPromise } from "../../packages/agent-api/src/effect.js";
import {
  CheckpointIncompatible,
  CommandRejected,
  decodeRpc,
  type DomainError,
  encodeRpc,
  ExecutionMissing,
  IdempotencyConflict,
  InvalidCursor,
  InvalidRuntimeEvent,
  InvalidSessionState,
  isDomainError,
  RecordTooLarge,
  rejection,
  rpcEnvelope,
  RuntimeRejected,
  SessionFailed,
  SessionNotFound,
  StorageFailure,
  Superseded,
  toApiError,
  TransportFailure,
  TurnCheckpointing,
  UnknownToolCall,
} from "../../packages/agent-api/src/errors.js";
import { ApiError, remoteApiError } from "../../packages/agent-api/src/protocol.js";
import type { Execution } from "../../packages/agent-api/src/runtime.js";
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
    accepted: { _tag: "Right" },
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

const execution: Execution = {
  sessionId: "sess_typed",
  turnId: "turn_typed",
  generation: 1,
  harness: "fixture",
  model: "fixture-model",
  agent: { model: "test" },
  input: [],
  checkpoint: null,
  deadline: Date.now() + 60_000,
  sandbox: false,
};
const failure = <A, E>(effect: Effect.Effect<A, E>) => runPromise(Effect.flip(effect));

it("fromPromiseDriver maps definite answers to tags and everything else to TransportFailure", async () => {
  const driver = fromPromiseDriver({
    name: "fixture",
    revision: "test-v1",
    capabilities: { steer: true, functions: true, sandbox: false },
    start: async () => {
      throw new ApiError(409, "checkpoint_incompatible", "Checkpoint belongs to another harness");
    },
    // A definite answer to poll is still not a batch: retried like any other failure.
    poll: async () => {
      throw new ApiError(400, "invalid_request", "Malformed batch");
    },
    control: async (_execution, _id, command) => {
      if (command.type === "cancel") throw new ApiError(404, "execution_missing", "No such job");
      // The wire name a HarnessDO rejection arrives with across Durable Object RPC.
      if (command.type === "steer")
        throw Object.assign(new Error("Turn is no longer active"), {
          name: "AgentApiError:409:command_rejected",
        });
      throw new Error("connection reset");
    },
    checkpoint: async () => {
      throw new Error("lost response");
    },
    stop: async () => {
      throw new ApiError(409, "unassigned_container", "Container has no session assignment");
    },
  });
  expect(await failure(driver.start(execution, "op"))).toMatchObject({
    _tag: "RuntimeRejected",
    status: 409,
    code: "checkpoint_incompatible",
  });
  expect(await failure(driver.poll(execution, 0))).toMatchObject({
    _tag: "TransportFailure",
    operation: "runtime.poll",
  });
  expect(await failure(driver.control(execution, "op", { type: "cancel" }))).toMatchObject({
    _tag: "ExecutionMissing",
    message: "No such job",
  });
  expect(
    await failure(driver.control(execution, "op", { type: "steer", input: [] })),
  ).toMatchObject({
    _tag: "CommandRejected",
    code: "command_rejected",
    message: "Turn is no longer active",
  });
  expect(
    await failure(
      driver.control(execution, "op", {
        type: "tool_result",
        callId: "c",
        success: true,
        output: "",
      }),
    ),
  ).toMatchObject({ _tag: "TransportFailure", operation: "runtime.control" });
  expect(await failure(driver.checkpoint(execution))).toMatchObject({
    _tag: "TransportFailure",
    operation: "runtime.checkpoint",
  });
  // Stop has no definite outcome to act on: any failure is retried by the next alarm.
  expect(await failure(driver.stop(execution))).toMatchObject({
    _tag: "TransportFailure",
    operation: "runtime.stop",
  });
  // A plain `{ status, code }` shape is a definite answer as well.
  expect(rejection({ status: 409, code: "stale_generation" })).toEqual({
    status: 409,
    code: "stale_generation",
    message: "stale_generation",
  });
  expect(rejection(new Error("connection reset"))).toBeUndefined();
});

it("the RPC envelope carries expected failures as data and decodes them into tagged instances", async () => {
  const envelope = rpcEnvelope(Schema.Null);
  const encoded = await runPromise(
    encodeRpc(envelope, Effect.fail(new IdempotencyConflict({ subject: "input" }))),
  );
  expect(encoded).toEqual({
    _tag: "Left",
    left: { _tag: "IdempotencyConflict", subject: "input" },
  });
  const decoded = await failure(decodeRpc(envelope)(JSON.parse(JSON.stringify(encoded))));
  expect(decoded).toBeInstanceOf(IdempotencyConflict);
  expect(decoded.name).toBe("AgentApiError:409:idempotency_conflict");
  expect(toApiError(decoded)).toMatchObject({
    status: 409,
    code: "idempotency_conflict",
    message: "Key was used with different input",
  });
  // A plain ApiError travels with its status and code and comes back as one.
  const plain = await runPromise(
    encodeRpc(envelope, Effect.fail(new ApiError(422, "unsupported_capability", "No images"))),
  );
  expect(plain).toEqual({
    _tag: "Left",
    left: { _tag: "ApiError", status: 422, code: "unsupported_capability", message: "No images" },
  });
  expect(await failure(decodeRpc(envelope)(plain))).toBeInstanceOf(ApiError);
  // Anything unexpected still throws through the platform instead of becoming data.
  await expect(
    runPromise(encodeRpc(envelope, Effect.fail(new OperationError({ operation: "x", cause: 1 })))),
  ).rejects.toMatchObject({ _tag: "OperationError" });
  expect(await runPromise(encodeRpc(envelope, Effect.succeed(null)))).toEqual({
    _tag: "Right",
    right: null,
  });
  expect(await runPromise(decodeRpc(envelope)({ _tag: "Right", right: null }))).toBeNull();
});

it("every domain failure projects to one ApiError and only definite ones carry its wire name", () => {
  const table: [DomainError, number, string][] = [
    [new RecordTooLarge({ bytes: 2_000_000 }), 413, "storage_record_too_large"],
    [new InvalidCursor(), 400, "invalid_cursor"],
    [new SessionNotFound(), 404, "not_found"],
    [new InvalidSessionState({ reason: "Inconsistent" }), 409, "invalid_session_state"],
    [new Superseded({ turnId: "turn_x", generation: 1 }), 409, "stale_generation"],
    [new IdempotencyConflict({ subject: "input" }), 409, "idempotency_conflict"],
    [new SessionFailed(), 409, "session_failed"],
    [new TurnCheckpointing(), 409, "turn_checkpointing"],
    [new UnknownToolCall({ callId: "c" }), 400, "invalid_request_error"],
    [
      new InvalidRuntimeEvent({ code: "invalid_runtime_cursor", message: "Gap" }),
      409,
      "invalid_runtime_cursor",
    ],
    [
      new CommandRejected({ code: "command_rejected", message: "Refused" }),
      409,
      "command_rejected",
    ],
    [new ExecutionMissing({ message: "Gone" }), 404, "execution_missing"],
    [
      new RuntimeRejected({ status: 422, code: "unsupported_capability", message: "No" }),
      422,
      "unsupported_capability",
    ],
    [new CheckpointIncompatible({ message: "Revision" }), 409, "invalid_checkpoint"],
    [new TransportFailure({ operation: "runtime.poll", cause: null }), 500, "internal_error"],
    [new StorageFailure({ operation: "session.transition", cause: null }), 500, "internal_error"],
  ];
  for (const [error, status, code] of table) {
    expect(isDomainError(error)).toBe(true);
    expect(toApiError(error)).toMatchObject({ status, code });
    const retryable = error._tag === "TransportFailure" || error._tag === "StorageFailure";
    expect(error.name.startsWith("AgentApiError:")).toBe(!retryable);
    expect(remoteApiError(error)?.code).toBe(retryable ? undefined : code);
  }
  expect(new UnknownToolCall({ callId: "missing" }).message).toBe(
    "Unknown pending tool call: missing",
  );
});
