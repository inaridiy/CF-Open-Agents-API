import { Container } from "@cloudflare/containers";
import { getSandbox, type ISandbox, Sandbox } from "@cloudflare/sandbox";
import { HARNESSES, type HarnessName } from "./harnesses.js";
import { readModelBody } from "./models/body.js";
import { ApiError } from "./protocol.js";
import type { Checkpoint, Execution, RuntimeCommand, RuntimeDriver } from "./runtime.js";
import { batchSchema } from "./runtime.js";
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
  private starting?: { turnId: string; promise: Promise<void> };
  private workspaceOperation: Promise<unknown> = Promise.resolve();
  protected async prepareSandbox(_sandbox: ISandbox, _execution: Execution): Promise<void> {}
  private async assignment(): Promise<Assignment> {
    const assignment = await this.ctx.storage.get<Assignment>("assignment");
    if (!assignment)
      throw new ApiError(409, "unassigned_container", "Container has no session assignment");
    return assignment;
  }
  override async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).hostname === "sandbox.internal") return this.sandboxRequest(request);
    return super.fetch(request);
  }
  private async sandboxRequest(request: Request): Promise<Response> {
    const assignment = await this.assignment();
    if (!assignment.sandbox) return new Response("No sandbox assigned", { status: 403 });
    if (new URL(request.url).pathname === "/tools" && request.method === "POST") {
      const input = await request.json();
      const operation = this.workspaceOperation.then(() =>
        executeWorkspaceTool(getSandbox(this.env.SANDBOX, assignment.sessionId), input),
      );
      this.workspaceOperation = operation.catch(() => {});
      try {
        return Response.json(await operation);
      } catch {
        return Response.json({ error: "Workspace operation failed" }, { status: 422 });
      }
    }
    return this.env.SANDBOX.getByName(assignment.sessionId).fetch(request);
  }
  async modelRequest(request: Request): Promise<Response> {
    const assignment = await this.assignment();
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== HARNESSES[assignment.harness].protocol)
      return new Response("Unsupported model request", { status: 403 });
    const bytes = await readModelBody(request);
    const body = JSON.parse(new TextDecoder().decode(bytes)) as { model?: string };
    if (body.model !== assignment.model)
      return new Response("Model is not assigned to this execution", { status: 403 });
    return this.env.MODEL_GATEWAY.fetch(new Request(request, { body: bytes }));
  }
  async startExecution(execution: Execution, operationId: string): Promise<void> {
    if (this.starting) {
      if (this.starting.turnId !== execution.turnId)
        throw new ApiError(409, "active_execution", "Another execution is starting");
      return this.starting.promise;
    }
    const promise = this.startAttempt(execution, operationId).finally(() => {
      this.starting = undefined;
    });
    this.starting = { turnId: execution.turnId, promise };
    return promise;
  }
  private async startAttempt(execution: Execution, operationId: string): Promise<void> {
    if (!Object.hasOwn(HARNESSES, execution.harness))
      throw new ApiError(400, "unsupported_harness", "Unknown Container harness");
    const harness = execution.harness as HarnessName;
    if (
      execution.checkpoint &&
      (execution.checkpoint.driver !== harness ||
        execution.checkpoint.revision !== HARNESSES[harness].revision)
    )
      throw new ApiError(
        409,
        "checkpoint_incompatible",
        "Checkpoint belongs to another harness version",
      );
    const previous = await this.ctx.storage.get<Assignment>("assignment");
    if (previous && execution.generation < previous.generation)
      throw new ApiError(409, "stale_generation", "Execution was superseded");
    if (previous?.turnId === execution.turnId && previous.dispatched) return;
    if (previous && previous.sessionId !== execution.sessionId)
      throw new ApiError(
        409,
        "assignment_conflict",
        "Container already belongs to another session",
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
    await this.ctx.storage.put("assignment", assignment);
    const sandbox = getSandbox(this.env.SANDBOX, execution.sessionId);
    if (execution.sandbox) {
      // Every new attempt starts from the last committed filesystem checkpoint.
      await sandbox.destroy();
      if (execution.checkpoint?.workspace)
        await sandbox.restoreBackup(execution.checkpoint.workspace);
      else {
        await sandbox.mkdir("/workspace", { recursive: true });
        await this.prepareSandbox(sandbox, execution);
      }
      if (harness === "codex") {
        const executor = await sandbox.exec([
          "codex",
          "exec-server",
          "--listen",
          "ws://0.0.0.0:4500",
        ]);
        await executor.waitForPort(4500);
      }
    }
    let checkpoint: unknown;
    if (execution.checkpoint) {
      const object = await this.env.CHECKPOINTS.get(execution.checkpoint.native);
      if (!object) throw new ApiError(409, "checkpoint_missing", "Native checkpoint is missing");
      checkpoint = await object.json();
    }
    await this.startAndWaitForPorts();
    // Durable dispatch tombstone: retries may inspect, but cannot replay a lost job.
    await this.ctx.storage.put("assignment", { ...assignment, dispatched: true });
    const result = await this.containerFetch("http://harness/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ execution, operationId, checkpoint }),
    });
    if (!result.ok) throw new Error(`Harness rejected start (${result.status})`);
  }
  async pollExecution(execution: Execution, after: number): Promise<Response> {
    const assignment = await this.assignment();
    if (assignment.turnId !== execution.turnId || assignment.generation !== execution.generation)
      return Response.json({ status: "missing", events: [], cursor: 0 });
    return this.containerFetch(`http://harness/jobs/${execution.turnId}?after=${after}`);
  }
  async controlExecution(
    execution: Execution,
    operationId: string,
    command: RuntimeCommand,
  ): Promise<void> {
    const assignment = await this.assignment();
    if (assignment.turnId !== execution.turnId || assignment.generation !== execution.generation)
      throw new ApiError(409, "stale_generation", "Execution was superseded");
    const result = await this.containerFetch(`http://harness/jobs/${execution.turnId}/control`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ operationId, command }),
    });
    if (!result.ok) throw new Error(`Harness rejected control (${result.status})`);
  }
  async checkpointExecution(execution: Execution): Promise<Checkpoint> {
    const assignment = await this.assignment();
    if (assignment.turnId !== execution.turnId || assignment.generation !== execution.generation)
      throw new ApiError(409, "stale_generation", "Execution was superseded");
    const key = `sessions/${execution.sessionId}/${execution.generation}/native.json`;
    const committed = await this.ctx.storage.get<Checkpoint>(`checkpoint:${execution.generation}`);
    if (committed) return committed;
    const response = await this.containerFetch(
      `http://harness/jobs/${execution.turnId}/checkpoint`,
    );
    if (!response.ok || !response.body) throw new Error("Native checkpoint failed");
    // containerFetch may return a chunked stream; R2 requires a known length.
    await this.env.CHECKPOINTS.put(key, await response.arrayBuffer());
    const workspace = execution.sandbox
      ? await getSandbox(this.env.SANDBOX, execution.sessionId).createBackup({
          dir: "/workspace",
          localBucket: this.env.LOCAL_BACKUPS === "true",
          ttl: 30 * 24 * 60 * 60,
        })
      : undefined;
    const checkpoint: Checkpoint = {
      version: 1,
      driver: assignment.harness,
      revision: HARNESSES[assignment.harness].revision,
      native: key,
      ...(workspace ? { workspace } : {}),
    };
    await this.ctx.storage.put(`checkpoint:${execution.generation}`, checkpoint);
    return checkpoint;
  }
  async stopExecution(execution: Execution): Promise<void> {
    const assignment = await this.assignment();
    if (assignment.turnId !== execution.turnId) return;
    await this.destroy();
    if (assignment.sandbox) await getSandbox(this.env.SANDBOX, execution.sessionId).destroy();
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
  return {
    name: harness,
    revision: HARNESSES[harness].revision,
    capabilities: { steer: HARNESSES[harness].steer, functions: true, sandbox: true },
    start: async (execution, operationId) => {
      await stub(execution).startExecution(execution, operationId);
    },
    poll: async (execution, after) =>
      batchSchema.parse(await (await stub(execution).pollExecution(execution, after)).json()),
    control: async (execution, operationId, command) => {
      await stub(execution).controlExecution(execution, operationId, command);
    },
    checkpoint: async (execution) => stub(execution).checkpointExecution(execution),
    stop: async (execution) => {
      await stub(execution).stopExecution(execution);
    },
  };
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
