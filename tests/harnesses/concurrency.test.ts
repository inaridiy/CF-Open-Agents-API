import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";
import { expect, it } from "vitest";

import {
  type Execution,
  io,
  type RuntimeBatch,
  type RuntimeCommand,
  runPromise,
} from "../../packages/agent-api/src/index.js";
import { Buffer } from "../../packages/supervisor/src/buffer.js";
import { type NativeJob, type NativeOptions, ToolJob } from "../../packages/supervisor/src/job.js";
import { Operations } from "../../packages/supervisor/src/lifecycle.js";
import { createSupervisor } from "../../packages/supervisor/src/server.js";

const execution: Execution = {
  sessionId: "sess_race",
  turnId: "turn_first",
  generation: 1,
  harness: "codex",
  model: "fixture",
  agent: { model: "fixture" },
  input: [],
  checkpoint: null,
  deadline: Date.now() + 60000,
  sandbox: false,
};
const options = {
  binary: "unused",
  directory: "/unused",
  modelBaseUrl: "http://unused",
  sandboxUrl: "http://unused",
  supervisorUrl: "http://unused",
  opencodeBinary: "unused",
  diagnostics: () => {},
};
const post = (app: ReturnType<typeof createSupervisor>["app"], path: string, body: unknown) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
class FakeJob implements NativeJob {
  status: RuntimeBatch["status"] = "completed";
  commands: RuntimeCommand[] = [];
  stopped = false;
  snapshot = async () => ({ version: 1 as const, threadId: "native", files: {} });
  readonly execution: Execution;
  constructor(startedExecution: Execution) {
    this.execution = startedExecution;
  }
  start() {
    return Effect.void;
  }
  poll(): Effect.Effect<RuntimeBatch> {
    return Effect.succeed({ status: this.status, events: [], cursor: 0 });
  }
  control(_id: string, command: RuntimeCommand) {
    this.commands.push(command);
    return Effect.void;
  }
  checkpoint() {
    return Effect.promise(() => this.snapshot());
  }
  stop() {
    this.stopped = true;
    return Effect.void;
  }
  failStart() {
    this.status = "failed";
  }
}

it("a control body delayed across replacement never targets the new job", async () => {
  const jobs: FakeJob[] = [];
  const supervisor = createSupervisor(options, (startedExecution) => {
    const job = new FakeJob(startedExecution);
    jobs.push(job);
    return job;
  });
  await post(supervisor.app, "/jobs", { execution, operationId: "first" });
  const entered = Promise.withResolvers<void>();
  let body!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      body = controller;
    },
    pull() {
      entered.resolve();
    },
  });
  const init = {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: stream,
    duplex: "half" as const,
  };
  const delayed = supervisor.app.fetch(new Request("http://local/jobs/turn_first/control", init));
  await entered.promise;
  const replaced = await post(supervisor.app, "/jobs", {
    execution: { ...execution, turnId: "turn_second", generation: 2 },
    operationId: "second",
  });
  expect(replaced.status).toBe(200);
  body.enqueue(
    new TextEncoder().encode(
      JSON.stringify({ operationId: "cancel", command: { type: "cancel" } }),
    ),
  );
  body.close();
  expect((await delayed).status).toBe(404);
  expect(jobs.map((job) => job.commands)).toEqual([[], []]);
  await supervisor.stop();
});

it("checkpoint holds ownership until capture finishes before a replacement starts", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const jobs: FakeJob[] = [];
  const supervisor = createSupervisor(options, (startedExecution) => {
    const job = new FakeJob(startedExecution);
    jobs.push(job);
    return job;
  });
  await post(supervisor.app, "/jobs", { execution, operationId: "first" });
  const first = jobs[0];
  if (!first) throw new Error("Missing fixture");
  first.snapshot = async () => {
    entered.resolve();
    await release.promise;
    expect(first.stopped).toBe(false);
    return { version: 1, threadId: "native", files: {} };
  };
  const checkpoint = supervisor.app.request("/jobs/turn_first/checkpoint");
  await entered.promise;
  const replacement = post(supervisor.app, "/jobs", {
    execution: { ...execution, turnId: "turn_second", generation: 2 },
    operationId: "second",
  });
  await Promise.resolve();
  expect(jobs).toHaveLength(1);
  release.resolve();
  expect((await checkpoint).status).toBe(200);
  expect((await replacement).status).toBe(200);
  expect(first.stopped).toBe(true);
  await supervisor.stop();
});

it("duplicate operation IDs share both success and uncertain failures and reject changed input", async () => {
  const operations = new Operations();
  let writes = 0;
  const write = io("test.write", async () => {
    writes++;
    await Promise.resolve();
    throw new Error("Response lost after write");
  });
  const outcomes = await Promise.allSettled(
    Array.from({ length: 8 }, () =>
      runPromise(operations.perform("op", { output: "first" }, write)),
    ),
  );
  expect(writes).toBe(1);
  expect(outcomes.every((result) => result.status === "rejected")).toBe(true);
  await expect(
    runPromise(operations.perform("op", { output: "changed" }, Effect.void)),
  ).rejects.toMatchObject({ _tag: "IdempotencyConflict" });
  await expect(runPromise(operations.perform("op", { output: "first" }, write))).rejects.toThrow();
  expect(writes).toBe(1);
});

class WaitingJob extends ToolJob {
  readonly home: string;
  readonly opening = Promise.withResolvers<void>();
  readonly release = Promise.withResolvers<void>();
  closes = 0;
  constructor(nativeOptions: NativeOptions) {
    super(execution, nativeOptions);
    this.home = nativeOptions.directory;
  }
  protected async open() {
    this.opening.resolve();
    await this.release.promise;
    this.sessionId = "native";
  }
  protected closeRuntime() {
    return Effect.sync(() => {
      this.closes++;
    });
  }
  call() {
    return this.externalTool("lookup", {});
  }
  complete() {
    this.lifecycle.setStatus("completed");
  }
  lateFailure() {
    this.failStart(new Error("late"));
  }
}

it("stop waits for resource acquisition, joins concurrent callers, and cannot be undone", async () => {
  const job = new WaitingJob(options);
  const start = runPromise(job.start());
  await job.opening.promise;
  const stops = [runPromise(job.stop()), runPromise(job.stop())];
  expect(job.closes).toBe(0);
  job.release.resolve();
  await start;
  await Promise.all(stops);
  expect(job.closes).toBe(1);
  job.complete();
  job.lateFailure();
  expect((await runPromise(job.poll(0))).status).toBe("cancelled");
  await expect(runPromise(job.start())).rejects.toThrow();
});

it("cancellation settles pending tools without allowing late results to resurrect the job", async () => {
  const job = new WaitingJob(options);
  job.release.resolve();
  await runPromise(job.start());
  const result = job.call();
  const rejection = expect(result).rejects.toThrow("Execution stopped");
  const call = (await runPromise(job.poll(0))).events[0]?.event;
  if (call?.type !== "function_call") throw new Error("Missing function call");
  await runPromise(job.control("cancel", { type: "cancel" }));
  await rejection;
  await expect(
    runPromise(
      job.control("result", {
        type: "tool_result",
        callId: call.callId,
        success: true,
        output: "late",
      }),
    ),
  ).rejects.toThrow();
  job.complete();
  job.lateFailure();
  expect((await runPromise(job.poll(0))).status).toBe("cancelled");
  expect(job.closes).toBe(1);
});

it("concurrent checkpoints capture one quiescent home and share the saved bundle", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cf-effect-checkpoint-"));
  const job = new WaitingJob({ ...options, directory });
  try {
    await writeFile(join(directory, "history.json"), "history");
    job.release.resolve();
    await runPromise(job.start());
    job.complete();
    const bundles = await Promise.all([
      runPromise(job.checkpoint()),
      runPromise(job.checkpoint()),
      runPromise(job.checkpoint()),
    ]);
    expect(bundles[0]?.files["history.json"]).toBe(Buffer.from("history").toString("base64"));
    expect(bundles[1]).toBe(bundles[0]);
    expect(bundles[2]).toBe(bundles[0]);
    expect(job.closes).toBe(1);
    job.lateFailure();
    expect((await runPromise(job.poll(0))).status).toBe("completed");
  } finally {
    await runPromise(job.stop());
    await rm(directory, { recursive: true, force: true });
  }
});

it("retained event pages do not hide completion from ownership replacement", async () => {
  const supervisor = createSupervisor(options, (startedExecution) => {
    const job = new FakeJob(startedExecution);
    // Pagination can still advertise running while older events remain to be read.
    job.poll = () => Effect.succeed({ status: "running", events: [], cursor: 0 });
    return job;
  });
  expect((await post(supervisor.app, "/jobs", { execution, operationId: "first" })).status).toBe(
    200,
  );
  expect(
    (
      await post(supervisor.app, "/jobs", {
        execution: { ...execution, turnId: "turn_second", generation: 2 },
        operationId: "second",
      })
    ).status,
  ).toBe(200);
  await supervisor.stop();
});

it("startup failure remains failed after resource cleanup", async () => {
  class BrokenJob extends WaitingJob {
    protected override async open() {
      throw new Error("Startup failed after acquisition");
    }
  }
  const job = new BrokenJob(options);
  await expect(runPromise(job.start())).rejects.toThrow();
  expect(job.status).toBe("failed");
  expect(job.closes).toBe(1);
  await runPromise(job.stop());
  expect(job.status).toBe("failed");
  expect(job.closes).toBe(1);
});
