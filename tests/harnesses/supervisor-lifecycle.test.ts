import { setTimeout as delay } from "node:timers/promises";

import { Effect } from "effect";
import { expect, it } from "vitest";

import {
  type Execution,
  type RuntimeBatch,
  type RuntimeCommand,
  type RuntimeEvent,
  runPromise,
} from "../../packages/agent-api/src/index.js";
import { type NativeOptions, ToolJob } from "../../packages/supervisor/src/job.js";
import { EVENT_LOG_LIMIT } from "../../packages/supervisor/src/lifecycle.js";
import { createSupervisor } from "../../packages/supervisor/src/server.js";
import { serveFetch } from "./http.js";

const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
const execution: Execution = {
  sessionId: "sess_lifecycle",
  turnId: "turn_parent",
  generation: 1,
  harness: "claude-code",
  model: "fixture",
  agent: {
    model: "fixture",
    multi_agent: { enabled: true },
    tools: [
      {
        type: "function",
        name: "lookup",
        description: "Look up a value",
        parameters: { type: "object", properties: {}, additionalProperties: false },
      },
      { type: "programmatic_tool_calling", enabled: true },
    ],
  },
  input: [],
  checkpoint: null,
  deadline: Date.now() + 60_000,
  sandbox: false,
  delegates: [{ alias: "helper", harness: "opencode", model: "fixture" }],
  maxConcurrentSubagents: 2,
};
const baseOptions: NativeOptions = {
  directory: "/unused",
  modelBaseUrl: "http://unused.invalid",
  sandboxUrl: "http://unused.invalid",
  supervisorUrl: "http://unused.invalid",
  opencodeBinary: "unused",
  diagnostics: () => {},
};

/** Exposes the shared lifecycle without a native runtime. */
class ProbeJob extends ToolJob {
  readonly home = "/unused";
  protected override async open() {
    this.sessionId = "native";
  }
  protected override closeRuntime() {
    return Effect.void;
  }
  delegate(prompt: string) {
    return this.perform(this.delegations.call("cf_delegate", { model: "helper", prompt }));
  }
  call(name = "lookup", invocation?: string) {
    return this.externalTool(name, {}, invocation);
  }
  code(input: unknown) {
    return this.executeCode(input);
  }
  finish() {
    this.lifecycle.setStatus("completed");
  }
}
const post = (url: string, path: string, body: unknown) =>
  fetch(url + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const unhandled: unknown[] = [];
process.on("unhandledRejection", (reason) => unhandled.push(reason));

it("a delegated child that overflows the event log fails the parent instead of the process", async () => {
  // One relayed batch carries more text than the retained log may hold.
  const oversized = "x".repeat(EVENT_LOG_LIMIT / 4 + 1);
  const delegate = await serveFetch(async (request) => {
    const url = new URL(request.url);
    const [, target] = url.pathname.split("/").slice(1);
    if (request.method === "POST" && target === "spawn")
      return Response.json({ subagentId: "subagent_big", turnId: "turn_big" });
    return Response.json({
      status: "completed",
      cursor: 5,
      events: Array.from({ length: 5 }, (_, index) => ({
        seq: index + 1,
        event: { type: "delta", id: "big", text: oversized } satisfies RuntimeEvent,
      })),
    } satisfies RuntimeBatch);
  });
  const diagnostics: string[] = [];
  const job = new ProbeJob(execution, {
    ...baseOptions,
    delegateUrl: delegate.url,
    diagnostics: (line) => diagnostics.push(line),
  });
  try {
    await runPromise(job.start());
    await job.delegate("overflow");
    await expect.poll(() => job.status, { timeout: 5_000, interval: 25 }).toBe("failed");
    expect((await runPromise(job.poll(0))).error).toBe("native_output_limit");
    await delay(50);
    expect(unhandled).toEqual([]);
  } finally {
    await runPromise(job.stop());
    await delegate.close();
  }
});

it("a tool registered during an image fetch survives the result that raced it", async () => {
  const release = Promise.withResolvers<void>();
  const media = await serveFetch(async () => {
    await release.promise;
    return new Response(Buffer.from(png, "base64"), { headers: { "content-type": "image/png" } });
  });
  const job = new ProbeJob(execution, { ...baseOptions, mediaUrl: media.url });
  try {
    await runPromise(job.start());
    const first = job.call();
    const firstCall = (await runPromise(job.poll(0))).events[0]?.event;
    if (firstCall?.type !== "function_call") throw new Error("Missing first call");
    const result = runPromise(
      job.control("first-result", {
        type: "tool_result",
        callId: firstCall.callId,
        success: true,
        output: [{ type: "input_image", image_url: "https://image.fixture/proof.png" }],
      }),
    );
    // The second call registers while the first result is still fetching its image.
    await delay(50);
    const second = job.call();
    await delay(50);
    release.resolve();
    await result;
    expect((await first).content[0]).toMatchObject({ type: "image", mimeType: "image/png" });
    expect(job.status).toBe("waiting");
    const secondCall = (await runPromise(job.poll(0))).events.at(-1)?.event;
    if (secondCall?.type !== "function_call") throw new Error("Missing second call");
    await runPromise(
      job.control("second-result", {
        type: "tool_result",
        callId: secondCall.callId,
        success: true,
        output: "late",
      }),
    );
    expect((await second).content).toEqual([{ type: "text", text: "late" }]);
    expect(job.status).toBe("running");
  } finally {
    await runPromise(job.stop());
    await media.close();
  }
});

it("a transient media failure is retryable under the same operation ID", async () => {
  let attempts = 0;
  const media = await serveFetch(async () => {
    attempts++;
    return attempts === 1
      ? new Response("flaky", { status: 500 })
      : new Response(Buffer.from(png, "base64"), { headers: { "content-type": "image/png" } });
  });
  const job = new ProbeJob(execution, { ...baseOptions, mediaUrl: media.url });
  try {
    await runPromise(job.start());
    const pending = job.call();
    const call = (await runPromise(job.poll(0))).events[0]?.event;
    if (call?.type !== "function_call") throw new Error("Missing call");
    const command: RuntimeCommand = {
      type: "tool_result",
      callId: call.callId,
      success: true,
      output: [{ type: "input_image", image_url: "https://image.fixture/proof.png" }],
    };
    await expect(runPromise(job.control("same-op", command))).rejects.toThrow();
    await runPromise(job.control("same-op", command));
    expect((await pending).content[0]).toMatchObject({ type: "image" });
    expect(attempts).toBe(2);
  } finally {
    await runPromise(job.stop());
    await media.close();
  }
});

it("code execution errors only count calls the code itself raised", async () => {
  const runner = await serveFetch(async () =>
    Response.json({ content: [{ type: "text", text: "boom" }], isError: true, terminal: false }),
  );
  const job = new ProbeJob(execution, { ...baseOptions, programmaticUrl: runner.url });
  try {
    await runPromise(job.start());
    // A native function call is outstanding while the model runs code.
    const native = job.call();
    const result = await job.code({ code: "throw new Error('boom')" });
    expect(result.isError).toBe(true);
    expect(job.status).toBe("waiting");
    const call = (await runPromise(job.poll(0))).events[0]?.event;
    if (call?.type !== "function_call") throw new Error("Missing call");
    await runPromise(
      job.control("native-result", {
        type: "tool_result",
        callId: call.callId,
        success: true,
        output: "ok",
      }),
    );
    expect((await native).isError).toBe(false);
  } finally {
    await runPromise(job.stop());
    await runner.close();
  }
});

it("stopping a parent with an unresponsive delegate route completes within its bound", async () => {
  const delegate = await serveFetch(async (request) => {
    const url = new URL(request.url);
    const [, target, action] = url.pathname.split("/").slice(1);
    if (request.method === "POST" && target === "spawn")
      return Response.json({ subagentId: "subagent_stuck", turnId: "turn_stuck" });
    if (action === "control")
      await delay(60_000, undefined, { signal: request.signal }).catch(() => {});
    if (action === "control") return new Response(null, { status: 204 });
    return Response.json({ status: "running", cursor: 0, events: [] } satisfies RuntimeBatch);
  });
  const job = new ProbeJob(execution, {
    ...baseOptions,
    delegateUrl: delegate.url,
    delegationTimeouts: { requestMs: 500, cancelMs: 300, settleMs: 200 },
  });
  try {
    await runPromise(job.start());
    await job.delegate("hang");
    const started = Date.now();
    await runPromise(job.control("cancel", { type: "cancel" }));
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(job.status).toBe("cancelled");
    expect(
      (await runPromise(job.poll(0))).events.some(
        ({ event }) => event.type === "subagent_turn" && event.status === "cancelled",
      ),
    ).toBe(true);
  } finally {
    await runPromise(job.stop());
    await delegate.close();
  }
});

it("the control route distinguishes rejected commands, missing executions and repeated cancels", async () => {
  let job: ProbeJob | undefined;
  const supervisor = createSupervisor(
    { ...baseOptions, binary: "unused" },
    (execution, options) => {
      job = new ProbeJob(execution, options);
      return job;
    },
  );
  const server = await serveFetch(async (request) => supervisor.app.fetch(request));
  try {
    const started = await post(server.url, "/jobs", { execution, operationId: "start" });
    expect(started.status).toBe(200);
    if (!job) throw new Error("Job was not created");
    const missing = await post(server.url, "/jobs/turn_absent/control", {
      operationId: "x",
      command: { type: "cancel" },
    });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ code: "execution_missing" });
    const steer = await post(server.url, "/jobs/turn_parent/control", {
      operationId: "steer",
      command: {
        type: "steer",
        input: [{ role: "user", content: [{ type: "input_text", text: "more" }] }],
      },
    });
    expect(steer.status).toBe(409);
    expect(await steer.json()).toMatchObject({ code: "command_rejected" });
    const unknown = await post(server.url, "/jobs/turn_parent/control", {
      operationId: "unknown",
      command: { type: "tool_result", callId: "call_absent", success: true, output: "x" },
    });
    expect(unknown.status).toBe(409);
    expect(await unknown.json()).toMatchObject({ code: "command_rejected" });
    job.finish();
    const late = await post(server.url, "/jobs/turn_parent/control", {
      operationId: "late",
      command: { type: "tool_result", callId: "call_absent", success: true, output: "x" },
    });
    expect(late.status).toBe(409);
    for (const operationId of ["cancel-1", "cancel-2"]) {
      const cancel = await post(server.url, "/jobs/turn_parent/control", {
        operationId,
        command: { type: "cancel" },
      });
      expect(cancel.status).toBe(204);
    }
    expect(job.status).toBe("completed");
  } finally {
    await supervisor.stop();
    await server.close();
  }
});
