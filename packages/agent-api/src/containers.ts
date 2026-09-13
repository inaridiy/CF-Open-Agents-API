import { Container } from "@cloudflare/containers";
import { getSandbox, type ISandbox, Sandbox } from "@cloudflare/sandbox";
import { Effect } from "effect";
import { decode, io, runPromise } from "./effect.js";
import { HARNESSES, type HarnessName } from "./harnesses.js";
import { readModelBody } from "./models/body.js";
import { ApiError } from "./protocol.js";
import type { Checkpoint, Execution, RuntimeCommand, RuntimeDriver } from "./runtime.js";
import { batchSchema, fromPromiseDriver } from "./runtime.js";
import { executeWorkspaceTool } from "./sandbox-tools.js";

export interface ContainerBindings {
  HARNESS: DurableObjectNamespace<HarnessContainer>;
  SANDBOX: DurableObjectNamespace<SandboxContainer>;
  CHECKPOINTS: R2Bucket;
  BACKUP_BUCKET: R2Bucket;
  MODEL_GATEWAY: Fetcher;
  LOCAL_BACKUPS?: string;
}
interface Assignment {
  sessionId: string;
  generation: number;
  turnId: string;
  model: string;
  harness: HarnessName;
  dispatched: boolean;
  sandbox: boolean;
}

export class SandboxContainer extends Sandbox<ContainerBindings> {
  override sleepAfter = "10m";
  override async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).hostname === "sandbox.internal")
      return this.containerFetch(request, 4500);
    return super.fetch(request);
  }
}

export class HarnessContainer<
  Env extends ContainerBindings = ContainerBindings,
> extends Container<Env> {
  override defaultPort = 8080;
  override sleepAfter = "10m";
  override enableInternet = false;
  private readonly lifecycle = Effect.unsafeMakeSemaphore(1);
  private readonly workspace = Effect.unsafeMakeSemaphore(1);
  protected async prepareSandbox(_sandbox: ISandbox, _execution: Execution): Promise<void> {}
  private assignment() {
    return Effect.gen(this, function* () {
      const assignment = yield* io("assignment", () =>
        this.ctx.storage.get<Assignment>("assignment"),
      );
      if (!assignment)
        return yield* Effect.fail(
          new ApiError(409, "unassigned_container", "Container has no session assignment"),
        );
      return assignment;
    });
  }
  override async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).hostname === "sandbox.internal") return this.sandboxRequest(request);
    return super.fetch(request);
  }
  private async sandboxRequest(request: Request): Promise<Response> {
    const assignment = await runPromise(this.assignment());
    if (!assignment.sandbox) return new Response("No sandbox assigned", { status: 403 });
    if (new URL(request.url).pathname === "/tools" && request.method === "POST") {
      const input = await request.json();
      const operation = runPromise(
        this.workspace.withPermits(1)(
          io("workspace.tool", async () => {
            const current = await runPromise(this.assignment());
            if (
              current.turnId !== assignment.turnId ||
              current.generation !== assignment.generation
            )
              throw new ApiError(409, "stale_generation", "Execution was superseded");
            return executeWorkspaceTool(getSandbox(this.env.SANDBOX, assignment.sessionId), input);
          }),
        ),
      );
      try {
        return Response.json(await operation);
      } catch {
        return Response.json({ error: "Workspace operation failed" }, { status: 422 });
      }
    }
    return this.env.SANDBOX.getByName(assignment.sessionId).fetch(request);
  }
  modelRequest(request: Request): Promise<Response> {
    return runPromise(
      Effect.gen(this, function* () {
        const assignment = yield* this.assignment();
        const url = new URL(request.url);
        if (request.method !== "POST" || url.pathname !== HARNESSES[assignment.harness].protocol)
          return new Response("Unsupported model request", { status: 403 });
        const bytes = yield* io("modelRequest", () => readModelBody(request));
        const body = JSON.parse(new TextDecoder().decode(bytes)) as { model?: string };
        if (!body || body.model !== assignment.model)
          return new Response("Model is not assigned to this execution", { status: 403 });
        const current = yield* this.assignment();
        if (current.turnId !== assignment.turnId || current.generation !== assignment.generation)
          return new Response("Execution was superseded", { status: 409 });
        return yield* io("modelRequest", () =>
          this.env.MODEL_GATEWAY.fetch(new Request(request, { body: bytes })),
        );
      }),
    );
  }
  startExecution(execution: Execution, operationId: string): Promise<void> {
    return runPromise(
      this.lifecycle.withPermits(1)(
        this.workspace.withPermits(1)(this.startAttempt(execution, operationId)),
      ),
    );
  }
  private startAttempt(execution: Execution, operationId: string) {
    return Effect.gen(this, function* () {
      if (!Object.hasOwn(HARNESSES, execution.harness))
        return yield* Effect.fail(
          new ApiError(400, "unsupported_harness", "Unknown Container harness"),
        );
      const harness = execution.harness as HarnessName;
      if (
        execution.checkpoint &&
        (execution.checkpoint.driver !== harness ||
          execution.checkpoint.revision !== HARNESSES[harness].revision)
      )
        return yield* Effect.fail(
          new ApiError(
            409,
            "checkpoint_incompatible",
            "Checkpoint belongs to another harness version",
          ),
        );
      const previous = yield* io("startAttempt", () =>
        this.ctx.storage.get<Assignment>("assignment"),
      );
      if (
        previous &&
        (execution.generation < previous.generation ||
          (execution.generation === previous.generation && execution.turnId !== previous.turnId))
      )
        return yield* Effect.fail(
          new ApiError(409, "stale_generation", "Execution was superseded"),
        );
      if (previous?.turnId === execution.turnId && previous.dispatched) return;
      if (previous && previous.sessionId !== execution.sessionId)
        return yield* Effect.fail(
          new ApiError(409, "assignment_conflict", "Container already belongs to another session"),
        );
      const assignment: Assignment = {
        sessionId: execution.sessionId,
        generation: execution.generation,
        turnId: execution.turnId,
        model: execution.model,
        harness,
        dispatched: false,
        sandbox: execution.sandbox,
      };
      yield* io("startAttempt", () => this.ctx.storage.put("assignment", assignment));
      const sandbox = getSandbox(this.env.SANDBOX, execution.sessionId);
      const previousCheckpoint = execution.checkpoint;
      const previousWorkspace = previousCheckpoint?.workspace;
      if (execution.sandbox) {
        // Every new attempt starts from the last committed filesystem checkpoint.
        yield* io("startAttempt", () => sandbox.destroy());
        if (previousWorkspace)
          yield* io("startAttempt", () => sandbox.restoreBackup(previousWorkspace));
        else {
          yield* io("startAttempt", () => sandbox.mkdir("/workspace", { recursive: true }));
          yield* io("startAttempt", () => this.prepareSandbox(sandbox, execution));
        }
        if (harness === "codex") {
          const executor = yield* io("startAttempt", () =>
            sandbox.exec(["codex", "exec-server", "--listen", "ws://0.0.0.0:4500"]),
          );
          yield* io("startAttempt", () => executor.waitForPort(4500));
        }
      }
      let checkpoint: unknown;
      if (previousCheckpoint) {
        const object = yield* io("startAttempt", () =>
          this.env.CHECKPOINTS.get(previousCheckpoint.native),
        );
        if (!object)
          return yield* Effect.fail(
            new ApiError(409, "checkpoint_missing", "Native checkpoint is missing"),
          );
        checkpoint = yield* io("startAttempt", () => object.json());
      }
      yield* io("startAttempt", () => this.startAndWaitForPorts());
      // Durable dispatch tombstone: retries may inspect, but cannot replay a lost job.
      yield* io("startAttempt", () =>
        this.ctx.storage.put("assignment", { ...assignment, dispatched: true }),
      );
      const result = yield* io("startAttempt", () =>
        this.containerFetch("http://harness/jobs", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ execution, operationId, checkpoint }),
        }),
      );
      if (!result.ok)
        return yield* Effect.fail(new Error(`Harness rejected start (${result.status})`));
    });
  }
  pollExecution(execution: Execution, after: number): Promise<Response> {
    return runPromise(
      Effect.gen(this, function* () {
        const assignment = yield* this.assignment();
        if (
          assignment.turnId !== execution.turnId ||
          assignment.generation !== execution.generation
        )
          return Response.json({ status: "missing", events: [], cursor: 0 });
        return yield* io("pollExecution", () =>
          this.containerFetch(`http://harness/jobs/${execution.turnId}?after=${after}`),
        );
      }),
    );
  }
  controlExecution(
    execution: Execution,
    operationId: string,
    command: RuntimeCommand,
  ): Promise<void> {
    return runPromise(
      Effect.gen(this, function* () {
        const assignment = yield* this.assignment();
        if (
          assignment.turnId !== execution.turnId ||
          assignment.generation !== execution.generation
        )
          return yield* Effect.fail(
            new ApiError(409, "stale_generation", "Execution was superseded"),
          );
        const result = yield* io("controlExecution", () =>
          this.containerFetch(`http://harness/jobs/${execution.turnId}/control`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ operationId, command }),
          }),
        );
        if (!result.ok)
          return yield* Effect.fail(new Error(`Harness rejected control (${result.status})`));
      }),
    );
  }
  checkpointExecution(execution: Execution): Promise<Checkpoint> {
    return runPromise(
      this.lifecycle.withPermits(1)(this.workspace.withPermits(1)(this.snapshot(execution))),
    );
  }
  private snapshot(execution: Execution) {
    return Effect.gen(this, function* () {
      const assignment = yield* this.assignment();
      if (assignment.turnId !== execution.turnId || assignment.generation !== execution.generation)
        return yield* Effect.fail(
          new ApiError(409, "stale_generation", "Execution was superseded"),
        );
      const key = `sessions/${execution.sessionId}/${execution.generation}/native.json`;
      const committed = yield* io("snapshot", () =>
        this.ctx.storage.get<Checkpoint>(`checkpoint:${execution.generation}`),
      );
      if (committed) return committed;
      const response = yield* io("snapshot", () =>
        this.containerFetch(`http://harness/jobs/${execution.turnId}/checkpoint`),
      );
      if (!response.ok || !response.body)
        return yield* Effect.fail(new Error("Native checkpoint failed"));
      // containerFetch may return a chunked stream; R2 requires a known length.
      const bytes = yield* io("snapshot", () => response.arrayBuffer());
      yield* io("snapshot", () => this.env.CHECKPOINTS.put(key, bytes));
      const workspace = execution.sandbox
        ? yield* io("snapshot", () =>
            getSandbox(this.env.SANDBOX, execution.sessionId).createBackup({
              dir: "/workspace",
              localBucket: this.env.LOCAL_BACKUPS === "true",
              ttl: 30 * 24 * 60 * 60,
            }),
          )
        : undefined;
      const checkpoint: Checkpoint = {
        version: 1,
        driver: assignment.harness,
        revision: HARNESSES[assignment.harness].revision,
        native: key,
        ...(workspace ? { workspace } : {}),
      };
      yield* io("snapshot", () =>
        this.ctx.storage.put(`checkpoint:${execution.generation}`, checkpoint),
      );
      return checkpoint;
    });
  }
  stopExecution(execution: Execution): Promise<void> {
    return runPromise(
      this.lifecycle.withPermits(1)(this.workspace.withPermits(1)(this.stopAttempt(execution))),
    );
  }
  private stopAttempt(execution: Execution) {
    return Effect.gen(this, function* () {
      const assignment = yield* this.assignment();
      if (assignment.turnId !== execution.turnId || assignment.generation !== execution.generation)
        return;
      yield* io("stopAttempt", () => this.destroy());
      if (assignment.sandbox)
        yield* io("stopAttempt", () => getSandbox(this.env.SANDBOX, execution.sessionId).destroy());
    });
  }
}

// The SDK registers handlers through its static setter. Class fields bypass it.
HarnessContainer.outboundByHost = {
  "sandbox.internal": async (request: Request, bindings: unknown, ctx: { containerId: string }) => {
    const env = bindings as ContainerBindings;
    return env.HARNESS.get(env.HARNESS.idFromString(ctx.containerId)).fetch(request);
  },
  "model.internal": async (request: Request, bindings: unknown, ctx: { containerId: string }) => {
    const env = bindings as ContainerBindings;
    return env.HARNESS.get(env.HARNESS.idFromString(ctx.containerId)).modelRequest(request);
  },
};

/** Deployment-owned provisioning runs once per fresh workspace, before any model call. */
export function createHarness<Env extends ContainerBindings>(
  prepare: (sandbox: ISandbox, execution: Execution, env: Env) => Promise<void>,
): typeof HarnessContainer<Env> {
  class ConfiguredHarness extends HarnessContainer<Env> {
    protected override prepareSandbox(sandbox: ISandbox, execution: Execution): Promise<void> {
      return prepare(sandbox, execution, this.env);
    }
  }
  // Register the concrete constructor: SDK handler registries are keyed by class name.
  ConfiguredHarness.outboundByHost = HarnessContainer.outboundByHost ?? {};
  return ConfiguredHarness;
}

export function containerDriver(env: ContainerBindings, harness: HarnessName): RuntimeDriver {
  const stub = (execution: Execution) => env.HARNESS.getByName(execution.sessionId);
  return fromPromiseDriver({
    name: harness,
    revision: HARNESSES[harness].revision,
    capabilities: { steer: HARNESSES[harness].steer, functions: true, sandbox: true },
    start: async (execution, operationId) => {
      await stub(execution).startExecution(execution, operationId);
    },
    poll: async (execution, after) =>
      decode(batchSchema, await (await stub(execution).pollExecution(execution, after)).json()),
    control: async (execution, operationId, command) => {
      await stub(execution).controlExecution(execution, operationId, command);
    },
    checkpoint: async (execution) => stub(execution).checkpointExecution(execution),
    stop: async (execution) => {
      await stub(execution).stopExecution(execution);
    },
  });
}

export const codexDriver = (env: ContainerBindings): RuntimeDriver => containerDriver(env, "codex");
export const claudeCodeDriver = (env: ContainerBindings): RuntimeDriver =>
  containerDriver(env, "claude-code");
export const openCodeDriver = (env: ContainerBindings): RuntimeDriver =>
  containerDriver(env, "opencode");
export const containerHarnesses = (env: ContainerBindings): Record<HarnessName, RuntimeDriver> => ({
  codex: codexDriver(env),
  "claude-code": claudeCodeDriver(env),
  opencode: openCodeDriver(env),
});
