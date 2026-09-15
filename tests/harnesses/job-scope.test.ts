import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { Effect } from "effect";
import { expect, it } from "vitest";

import {
  batchSchema,
  decode,
  type Execution,
  runPromise,
} from "../../packages/agent-api/src/index.js";
import { type NativeOptions, ToolJob } from "../../packages/supervisor/src/job.js";
import { createSupervisor } from "../../packages/supervisor/src/server.js";
import { serveFetch } from "./http.js";

const execution: Execution = {
  sessionId: "sess_scope",
  turnId: "turn_scope",
  generation: 1,
  harness: "claude-code",
  model: "fixture",
  agent: {
    model: "fixture",
    tools: [
      {
        type: "function",
        name: "lookup",
        description: "Look up a value",
        parameters: { type: "object", properties: {}, additionalProperties: false },
      },
    ],
  },
  input: [],
  checkpoint: null,
  deadline: Date.now() + 60_000,
  sandbox: false,
};
const options: NativeOptions = {
  directory: "/unused",
  modelBaseUrl: "http://unused.invalid",
  sandboxUrl: "http://unused.invalid",
  supervisorUrl: "http://unused.invalid",
  opencodeBinary: "unused",
  diagnostics: () => {},
};

/** A job without a native runtime: tool calls raise events on demand. */
class ProbeJob extends ToolJob {
  readonly home = "/unused";
  protected override async open() {
    this.sessionId = "native";
  }
  protected override closeRuntime() {
    return Effect.void;
  }
  call() {
    return this.externalTool("lookup", {});
  }
}
/** A job whose "runtime" is a process that ignores SIGTERM and a task that never returns. */
class StubbornJob extends ToolJob {
  readonly home = "/unused";
  child?: ChildProcess;
  protected override async open() {
    const child = spawn(
      process.execPath,
      [
        "-e",
        "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); process.stdout.write('ready')",
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    this.child = child;
    // The signal handler must be installed before the stop sequence sends SIGTERM.
    await new Promise<void>((resolve) => child.stdout?.once("data", () => resolve()));
    await this.own(child, "200 millis");
    this.run(Effect.never);
  }
  protected override closeRuntime() {
    return Effect.void;
  }
}
/** A job whose only runtime is the shared remote-tool bridge. */
class RemoteToolJob extends ToolJob {
  constructor(
    spec: Execution,
    config: NativeOptions,
    readonly home: string,
  ) {
    super(spec, config);
  }
  protected override async open(bundle?: unknown) {
    await this.prepare(bundle);
    this.sessionId = "native";
  }
  protected override closeRuntime() {
    return Effect.void;
  }
  remote(name: string) {
    return this.perform(this.remoteTools.call(name, {}));
  }
}
const read = (url: string, query: string) =>
  fetch(`${url}/jobs/${execution.turnId}?${query}`).then(async (response) =>
    decode(batchSchema, await response.json()),
  );

it("GET /jobs/:turn?wait= returns early on a new event and times out cleanly", async () => {
  let job: ProbeJob | undefined;
  const supervisor = createSupervisor({ ...options, binary: "unused" }, (spec, config) => {
    job = new ProbeJob(spec, config);
    return job;
  });
  const server = await serveFetch(async (request) => supervisor.app.fetch(request));
  try {
    const started = await fetch(`${server.url}/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ execution, operationId: "start" }),
    });
    expect(started.status).toBe(200);
    if (!job) throw new Error("Job was not created");
    // Without `wait`, an empty log answers at once.
    expect(await read(server.url, "after=0")).toMatchObject({ status: "running", events: [] });
    // A long poll returns as soon as an event lands, well before its bound.
    const waiting = read(server.url, "after=0&wait=5000");
    await delay(150);
    const pending = job.call();
    const began = Date.now();
    const batch = await waiting;
    expect(Date.now() - began).toBeLessThan(1_000);
    expect(batch.status).toBe("waiting");
    expect(batch.events.map(({ event }) => event.type)).toEqual(["function_call"]);
    // Nothing new after the cursor: the poll waits its bound, then answers empty.
    const quiet = Date.now();
    const empty = await read(server.url, `after=${batch.cursor}&wait=300`);
    expect(Date.now() - quiet).toBeGreaterThanOrEqual(250);
    expect(empty).toMatchObject({ status: "waiting", events: [], cursor: batch.cursor });
    // Terminal outcomes never wait; the raised call settles as the job stops.
    const rejection = expect(pending).rejects.toThrow("Execution stopped");
    await runPromise(job.stop());
    const sealed = Date.now();
    expect(await read(server.url, `after=${batch.cursor}&wait=5000`)).toMatchObject({
      status: "cancelled",
      events: [],
    });
    expect(Date.now() - sealed).toBeLessThan(1_000);
    await rejection;
  } finally {
    await supervisor.stop();
    await server.close();
  }
});

it("stopping a running job terminates the native process it owns and interrupts its task", async () => {
  const job = new StubbornJob(execution, options);
  await runPromise(job.start());
  const child = job.child;
  if (!child) throw new Error("Process was not spawned");
  expect(child.exitCode).toBeNull();
  expect(job.status).toBe("running");
  const began = Date.now();
  await runPromise(job.stop());
  // The task never resolved on its own; the Scope interrupted it and escalated to SIGKILL.
  expect(Date.now() - began).toBeLessThan(5_000);
  expect(child.signalCode).toBe("SIGKILL");
  expect(job.status).toBe("cancelled");
  await expect(runPromise(job.start())).rejects.toThrow();
});

it("stopping a job with an unanswered MCP call closes the connection within the bound", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cf-job-scope-"));
  let held = 0;
  const released = Promise.withResolvers<void>();
  // Answers the handshake and the catalog; a tool call is held open until the client goes away.
  const mcp = await serveFetch(async (request) => {
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const message = (await request.json()) as { id?: number; method: string };
    if (message.id === undefined) return new Response(null, { status: 202 });
    if (message.method === "tools/call") {
      held++;
      request.signal.addEventListener("abort", () => released.resolve(), { once: true });
      await released.promise;
      return new Response(null, { status: 499 });
    }
    return Response.json({
      jsonrpc: "2.0",
      id: message.id,
      result:
        message.method === "initialize"
          ? {
              protocolVersion: "2025-03-26",
              capabilities: { tools: {} },
              serverInfo: { name: "fixture", version: "1" },
            }
          : { tools: [{ name: "hang", description: "hang", inputSchema: { type: "object" } }] },
    });
  });
  const job = new RemoteToolJob(
    {
      ...execution,
      agent: {
        model: "fixture",
        tools: [
          {
            type: "mcp",
            server_label: "fixture",
            transport: { type: "http", server_url: mcp.url },
            required: true,
          },
        ],
      },
    },
    options,
    join(directory, "home"),
  );
  try {
    await runPromise(job.start());
    const pending = job.remote("remote_0__hang");
    // `rejects` attaches the handler before the stop settles the call.
    const rejection = expect(pending).rejects.toThrow();
    for (let attempt = 0; held === 0 && attempt < 500; attempt++) await delay(10);
    expect(held).toBe(1);
    const began = Date.now();
    await runPromise(job.stop());
    // Neither the 120 s call bound nor the SDK's own request timer held the stop.
    expect(Date.now() - began).toBeLessThan(5_000);
    expect(job.status).toBe("cancelled");
    await rejection;
    // Closing the job's Scope closed the client: the server saw its held request end.
    await Promise.race([
      released.promise,
      delay(3_000).then(() => {
        throw new Error("The MCP request outlived the job");
      }),
    ]);
  } finally {
    await runPromise(job.stop());
    await mcp.close();
    await rm(directory, { recursive: true, force: true });
  }
});
