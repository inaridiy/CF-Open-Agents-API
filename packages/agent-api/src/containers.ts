import { Container } from "@cloudflare/containers";
import { getSandbox, type ISandbox } from "@cloudflare/sandbox";
import { Effect, Layer, ManagedRuntime } from "effect";

import { EnvironmentWorkspace, type ExportedEnvironment } from "./container-environments.js";
import {
  admittedHarness,
  buildAssignment,
  commandParts,
  imageDigests,
  jobBody,
  rejectionMessage,
  remoteImageURLs,
  startAdmission,
  superseded,
} from "./containers/assignment.js";
import { loadCheckpoint, snapshot } from "./containers/checkpoint.js";
import { delegateRequest } from "./containers/delegation.js";
import { diagnosticsHint } from "./containers/diagnostics.js";
import {
  assignment,
  type ContainerBindings,
  HarnessBindings,
  type HarnessHost,
  HarnessRepo,
  type HarnessServices,
  read,
  write,
} from "./containers/host.js";
import * as proxies from "./containers/proxies.js";
import {
  attachCapabilities,
  ensureCodexServer,
  prepareWorkspace,
  rememberSandbox,
} from "./containers/sandbox.js";
import { decode, io, settle } from "./effect.js";
import type { EnvironmentDriver } from "./environments.js";
import { CommandRejected, ExecutionMissing, Superseded, TransportFailure } from "./errors.js";
import { HARNESSES, type HarnessName } from "./harnesses.js";
import { type HarnessTx, makeHarnessRepo, makeHarnessTx } from "./persistence/harness-tx.js";
import type { Checkpoint, Execution, RuntimeCommand, RuntimeDriver } from "./runtime.js";
import { batchSchema, fromPromiseDriver } from "./runtime.js";
import { SqlStore } from "./storage.js";

export { diagnosticsHint, WORKER_UNREACHABLE_HINT } from "./containers/diagnostics.js";
export {
  type ContainerBindings,
  HarnessBindings,
  type HarnessHost,
  HarnessRepo,
  type HarnessServices,
} from "./containers/host.js";
export { SandboxContainer } from "./containers/sandbox.js";

/** Long-poll bound the supervisor accepts; the HarnessDO stays under its fetch timeout. */
const LONG_POLL_MAX_MS = 25_000;

export class HarnessContainer<
  Env extends ContainerBindings = ContainerBindings,
> extends Container<Env> {
  override defaultPort = 8080;
  override sleepAfter = "10m";
  override enableInternet = false;
  private readonly lifecycle = Effect.unsafeMakeSemaphore(1);
  private readonly workspace = Effect.unsafeMakeSemaphore(1);
  /** Assignment, child and checkpoint records carry agent configuration; SQLite rows, not KV values. */
  private readonly db = new SqlStore(this.ctx.storage);
  /** Synchronous typed view for callbacks the runtime invokes outside a fiber. */
  private readonly tx: HarnessTx = makeHarnessTx(this.db);
  /**
   * One runtime per object with the repository and the bindings; every entrypoint runs
   * its program here and nothing below an entrypoint calls `Effect.run*`. The layers hold
   * no resources, so an evicted object leaks nothing by never disposing it.
   */
  private readonly runtime = ManagedRuntime.make(
    Layer.mergeAll(
      Layer.succeed(HarnessRepo, makeHarnessRepo(this.db, this.ctx.storage)),
      Layer.succeed(HarnessBindings, this.env),
    ),
  );
  private readonly environment = new EnvironmentWorkspace(
    this.ctx.storage,
    this.env,
    (sessionId, environmentId) =>
      io("environment.export", () =>
        this.env.HARNESS.getByName(sessionId).exportEnvironment(environmentId),
      ),
  );
  private readonly codeExecutions = new Set<AbortController>();
  /** Boundary runner: a failure is thrown as itself so its RPC wire name survives. */
  private run<A, E>(program: Effect.Effect<A, E, HarnessServices>): Promise<A> {
    // lint: entrypoint
    return this.runtime.runPromiseExit(program).then(settle);
  }
  private abortCodeExecutions(): void {
    for (const controller of this.codeExecutions) controller.abort();
  }
  /** What the programs in `containers/*` need from this object; see `HarnessHost`. */
  private readonly host: HarnessHost = {
    env: this.env,
    tx: this.tx,
    environment: this.environment,
    workspace: this.workspace,
    codeExecutions: this.codeExecutions,
    containerFetch: (request, init) => this.containerFetch(request, init),
    child: (subagentId) => this.child(subagentId),
    abortCodeExecutions: () => this.abortCodeExecutions(),
    prepareSandbox: (sandbox, execution) => this.prepareSandbox(sandbox, execution),
  };
  mediaRequest(request: Request): Promise<Response> {
    return this.run(proxies.mediaRequest(request));
  }
  programmaticRequest(request: Request): Promise<Response> {
    return this.run(proxies.programmaticRequest(this.host, request));
  }
  mcpRequest(request: Request): Promise<Response> {
    return this.run(proxies.mcpRequest(this.host, request));
  }
  /**
   * Private route for the parent supervisor: start, poll and control delegated children;
   * see `containers/delegation.ts`.
   */
  delegateRequest(request: Request): Promise<Response> {
    return this.run(delegateRequest(this.host, request));
  }
  modelRequest(request: Request): Promise<Response> {
    return this.run(proxies.modelRequest(this.host, request));
  }
  prepareEnvironment(...args: Parameters<EnvironmentDriver["prepare"]>) {
    const [spec] = args;
    return this.run(
      this.workspace.withPermits(1)(
        this.environment.prepare(...args).pipe(
          // Setup left the live sandbox holding exactly the committed base (plus whatever
          // setup commands wrote outside /workspace); the first turn can continue in it.
          Effect.zipRight(
            Effect.gen(this, function* () {
              const base = this.environment.base();
              if ((yield* read((tx) => tx.sandbox())) || !base) return;
              yield* rememberSandbox(getSandbox(this.env.SANDBOX, spec.sessionId), {
                workspaceId: base.id,
                provisioned: this.environment.inherited(),
              });
            }),
          ),
        ),
      ),
    );
  }
  environmentStatus(...args: Parameters<EnvironmentDriver["status"]>) {
    return this.run(this.environment.status(...args));
  }
  async exportEnvironment(environmentId: string): Promise<ExportedEnvironment> {
    return this.environment.exported(environmentId);
  }
  uploadEnvironmentFile(...args: Parameters<EnvironmentDriver["upload"]>) {
    return this.run(this.workspace.withPermits(1)(this.environment.upload(...args)));
  }
  environmentFiles(...args: Parameters<EnvironmentDriver["files"]>) {
    return this.run(this.workspace.withPermits(1)(this.environment.files(...args)));
  }
  protected async prepareSandbox(_sandbox: ISandbox, _execution: Execution): Promise<void> {}
  private child(subagentId: string) {
    return this.env.HARNESS.getByName(`${this.ctx.id.toString()}/${subagentId}`);
  }
  override async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).hostname === "sandbox.internal")
      return this.run(proxies.sandboxRequest(this.host, request));
    return super.fetch(request);
  }
  startExecution(execution: Execution, operationId: string): Promise<void> {
    return this.run(
      this.lifecycle.withPermits(1)(
        this.workspace.withPermits(1)(this.startAttempt(execution, operationId)),
      ),
    );
  }
  private startAttempt(execution: Execution, operationId: string) {
    return Effect.gen(this, function* () {
      const harness = yield* admittedHarness(execution);
      const previous = yield* read((tx) => tx.assignment());
      if ((yield* startAdmission(execution, previous)) === "dispatched") return;
      const digests = yield* imageDigests(
        remoteImageURLs(execution.input.flatMap((message) => message.content)),
        [],
      );
      const assigned = buildAssignment(execution, harness, digests);
      this.abortCodeExecutions();
      yield* write((tx) => tx.putAssignment(assigned));
      const sandbox = getSandbox(this.env.SANDBOX, execution.sessionId);
      const previousCheckpoint = execution.checkpoint;
      const previousWorkspace = previousCheckpoint?.workspace ?? this.environment.base();
      // A delegated child joins the parent's live sandbox; only the parent resets it.
      if (execution.sandbox && !execution.parent)
        yield* prepareWorkspace(this.host, sandbox, execution, previousWorkspace);
      if (execution.sandbox && harness === "codex") yield* ensureCodexServer(sandbox);
      const capabilityRoots = execution.parent
        ? [...(execution.capabilityRoots ?? [])]
        : this.environment.capabilityRoots();
      let portableInstructions = "";
      if (harness !== "codex" && execution.sandbox) {
        const attached = yield* attachCapabilities(
          sandbox,
          execution,
          assigned.mcp ?? [],
          capabilityRoots,
        );
        portableInstructions = attached.instructions;
        assigned.mcp = attached.mcp;
      }
      const checkpoint = yield* loadCheckpoint(previousCheckpoint);
      yield* io("startAttempt", (signal) =>
        this.startAndWaitForPorts(undefined, { abort: signal }),
      );
      // Durable dispatch tombstone: retries may inspect, but cannot replay a lost job. The
      // marker and the dispatch it describes are one uninterruptible step: an interrupt
      // between them, or mid-request, would leave a marker for a job that never started.
      const result = yield* Effect.uninterruptible(
        write((tx) => tx.putAssignment({ ...assigned, dispatched: true })).pipe(
          Effect.zipRight(
            io("startAttempt", () =>
              this.containerFetch("http://harness/jobs", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: jobBody(
                  execution,
                  assigned,
                  capabilityRoots,
                  portableInstructions,
                  operationId,
                  checkpoint,
                ),
              }),
            ),
          ),
        ),
      );
      if (!result.ok)
        return yield* new TransportFailure({
          operation: "startAttempt",
          cause: `Harness rejected start (${result.status})`,
        });
    });
  }
  /**
   * Events after `after`. With `waitMs` above zero and a dispatched, unrevoked assignment,
   * the supervisor holds an empty answer up to that long for the next event or terminal
   * outcome; the reconciler stays under its alarm interval, and this stays under 25 s.
   */
  pollExecution(execution: Execution, after: number, waitMs = 0): Promise<Response> {
    return this.run(
      Effect.gen(this, function* () {
        const current = yield* assignment;
        if (superseded(current, execution))
          return Response.json({ status: "missing", events: [], cursor: 0 });
        const wait =
          current.dispatched && !current.revoked
            ? Math.min(Math.max(0, Math.floor(waitMs)), LONG_POLL_MAX_MS)
            : 0;
        return yield* io("pollExecution", (signal) =>
          this.containerFetch(
            `http://harness/jobs/${execution.turnId}?after=${after}${wait > 0 ? `&wait=${wait}` : ""}`,
            { signal },
          ),
        );
      }),
    );
  }
  controlExecution(
    execution: Execution,
    operationId: string,
    command: RuntimeCommand,
  ): Promise<void> {
    return this.run(
      Effect.gen(this, function* () {
        const current = yield* assignment;
        if (superseded(current, execution))
          return yield* new Superseded({
            turnId: execution.turnId,
            generation: execution.generation,
          });
        const parts = commandParts(command);
        const allowedImages = remoteImageURLs(parts);
        if (allowedImages.length) {
          const digests = yield* imageDigests(allowedImages, current.imageDigests ?? []);
          yield* write((tx) => tx.putAssignment({ ...current, imageDigests: digests }));
        }
        // Interruptible: the supervisor deduplicates control by operationId, so an aborted
        // delivery is retried by the next alarm without applying the command twice.
        const result = yield* io("controlExecution", (signal) =>
          this.containerFetch(`http://harness/jobs/${execution.turnId}/control`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ operationId, command }),
            signal,
          }),
        );
        if (command.type === "cancel") this.abortCodeExecutions();
        if (!result.ok) {
          // A definite rejection is an API error the session can act on; anything else is retried.
          const body = yield* io(
            "controlExecution.body",
            (): Promise<{ code?: unknown; message?: unknown; error?: unknown }> =>
              result
                .json<{ code?: unknown; message?: unknown; error?: unknown }>()
                .catch(() => ({})),
          );
          const message = rejectionMessage(body, result.status);
          if (result.status === 409)
            return yield* new CommandRejected({ code: "command_rejected", message });
          if (result.status === 404) return yield* new ExecutionMissing({ message });
          return yield* new TransportFailure({ operation: "controlExecution", cause: message });
        }
      }),
    );
  }
  checkpointExecution(execution: Execution): Promise<Checkpoint> {
    return this.run(
      this.lifecycle.withPermits(1)(this.workspace.withPermits(1)(snapshot(this.host, execution))),
    );
  }
  stopExecution(execution: Execution): Promise<void> {
    return this.run(
      this.lifecycle.withPermits(1)(this.workspace.withPermits(1)(this.stopAttempt(execution))),
    );
  }
  private stopAttempt(execution: Execution) {
    return Effect.gen(this, function* () {
      const current = yield* assignment;
      if (superseded(current, execution)) return;
      this.abortCodeExecutions();
      yield* write((tx) => tx.putAssignment({ ...current, revoked: true }));
      // Native stderr is lost with the Container; keep a bounded tail in Worker logs.
      if (current.dispatched)
        yield* io("stopAttempt.diagnostics", async (signal) => {
          const response = await this.containerFetch("http://harness/diagnostics", {
            signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
          });
          if (!response.ok) return;
          const { lines } = (await response.json()) as { lines?: string[] };
          if (lines?.length) {
            const hint = diagnosticsHint(lines);
            console.warn("Native harness diagnostics", {
              sessionId: execution.sessionId,
              turnId: execution.turnId,
              lines: lines.slice(-50),
              ...(hint ? { hint } : {}),
            });
          }
        }).pipe(Effect.ignore);
      // Children stop before the parent releases the sandbox they share.
      const children = yield* read((tx) =>
        (current.children ?? []).flatMap((subagentId) => {
          const child = tx.child(subagentId);
          return child && !child.terminal ? [{ subagentId, execution: child.execution }] : [];
        }),
      );
      for (const child of children)
        yield* io("stopAttempt.child", () =>
          this.child(child.subagentId).stopExecution(child.execution),
        ).pipe(Effect.ignore);
      yield* io("stopAttempt", () => this.destroy());
      if (current.sandbox && !current.parent) {
        // Uncommitted workspace state is discarded; the next turn restores the last checkpoint.
        yield* write((tx) => tx.forgetSandbox());
        yield* io("stopAttempt", () => getSandbox(this.env.SANDBOX, execution.sessionId).destroy());
      }
    });
  }
}

export function containerEnvironments(env: ContainerBindings): EnvironmentDriver {
  const stub = (sessionId: string) => env.HARNESS.getByName(sessionId);
  return {
    prepare: (spec) =>
      io("environment.prepare", () => stub(spec.sessionId).prepareEnvironment(spec)),
    status: (spec) => io("environment.status", () => stub(spec.sessionId).environmentStatus(spec)),
    upload: (spec, input) =>
      io("environment.upload", () => stub(spec.sessionId).uploadEnvironmentFile(spec, input)),
    files: (spec, query) =>
      io("environment.files", () => stub(spec.sessionId).environmentFiles(spec, query)),
  };
}

// The SDK registers handlers through its static setter. Class fields bypass it.
HarnessContainer.outboundByHost = proxies.outboundByHost;

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
    capabilities: {
      steer: HARNESSES[harness].steer,
      functions: true,
      sandbox: true,
      subagents: true,
      images: true,
      reasoningSummaries: true,
      usage: true,
      // Codex searches through its Responses connection; Claude Code through Anthropic's
      // hosted WebSearch tool. Both need an alias whose model connection supports it.
      webSearch: harness === "codex" || harness === "claude-code",
      commandOutputDeltas: true,
      programmaticToolCalling: !!env.CODE_LOADER,
      mcp: true,
      toolSearch: true,
      environmentCapabilities: true,
      // Codex dynamic tools are part of thread/start; thread/resume cannot change them.
      toolsFixedAtStart: harness === "codex",
    },
    start: async (execution, operationId) => {
      await stub(execution).startExecution(execution, operationId);
    },
    // The supervisor holds an empty answer for `waitMs`; see `HarnessContainer.pollExecution`.
    longPoll: true,
    poll: async (execution, after, _signal, options) =>
      decode(
        batchSchema,
        await (await stub(execution).pollExecution(execution, after, options.waitMs)).json(),
      ),
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
