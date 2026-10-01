import { DurableObject } from "cloudflare:workers";
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
  type ContainerEgressProps,
  type EntrypointLoopback,
  exported,
  HARNESS_EGRESS_HOSTS,
} from "./containers/egress.js";
import {
  assignment,
  type ContainerBindings,
  HarnessBindings,
  type HarnessHost,
  HarnessRepo,
  type HarnessServices,
  read,
  releaseBody,
  write,
} from "./containers/host.js";
import { makeLease } from "./containers/lease.js";
import * as proxies from "./containers/proxies.js";
import type { ContainerInstance } from "./containers/sandbox.js";
import {
  attachCapabilities,
  ensureCodexServer,
  prepareWorkspace,
  rememberSandbox,
  sandboxOf,
  type Workspace,
  workspaceOf,
} from "./containers/workspace.js";
import { decode, io, settle } from "./effect.js";
import type { EnvironmentDriver } from "./environments.js";
import {
  CommandRejected,
  ContainerMisconfigured,
  ExecutionMissing,
  Superseded,
  TransportFailure,
} from "./errors.js";
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
export { ContainerEgress, SandboxEgress } from "./containers/egress.js";
export {
  type ContainerInstance,
  type LegacyWorkspaceBackup,
  SandboxContainer,
  type WorkspaceBackup,
} from "./containers/sandbox.js";
export type { Workspace } from "./containers/workspace.js";

/** A failure this cleanup cannot act on. */
const ignore = (): void => {};
/** Long-poll bound the supervisor accepts; the HarnessDO stays under its fetch timeout. */
const LONG_POLL_MAX_MS = 25_000;
/** The named image a HarnessDO starts: `containers[].images.harness` in Wrangler configuration. */
export const HARNESS_IMAGE = "harness";
const SUPERVISOR_PORT = 8080;
/** How long a fresh harness container may take to answer before the boot fails. */
const READY_TIMEOUT_MS = 90_000;
const IDLE_MS = 10 * 60 * 1000;
/** The platform's own stop after the object goes inactive; the lease's idle timer decides first. */
const INACTIVITY_BACKSTOP_MS = IDLE_MS + 5 * 60 * 1000;
/** A turn keeps its sandbox from idling out at most this often. */
const SANDBOX_TOUCH_MS = 60_000;

/**
 * One session's execution: the harness container with the supervisor and the native
 * runtime, its egress, and the turn's assignment. A lease boots the container on first
 * use, keeps it while turns poll it, destroys it after ten idle minutes, and never boots
 * it again once the session is deleted.
 */
export class HarnessContainer<
  Env extends ContainerBindings = ContainerBindings,
> extends DurableObject<Env> {
  /** The size `start()` requests; `defineAgentWorker({ instances })` overrides it. */
  protected instance: ContainerInstance = "standard-1";
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
      Layer.succeed(HarnessRepo, makeHarnessRepo(this.db)),
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
  private readonly lease = makeLease({
    storage: this.ctx.storage,
    container: () => this.ctx.container,
    boot: Effect.suspend(() => this.boot()),
    destroy: io("harness.destroy", () => this.container().destroy()),
    idleMs: () => this.idleMs(),
    label: "harness",
  });
  private sandboxTouched = 0;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // The inactivity timeout does not survive a restart of this object; set it again.
    const container = ctx.container;
    if (container?.running)
      void ctx.blockConcurrencyWhile(() =>
        container.setInactivityTimeout(INACTIVITY_BACKSTOP_MS).catch(ignore),
      );
  }
  /** How long the harness container runs after its last poll. */
  protected idleMs(): number {
    return IDLE_MS;
  }
  /** Re-reads `idleMs()` into the lease, booting the container if it is not running. */
  protected renewLease(): Promise<void> {
    return this.run(this.lease.renew);
  }
  private container(): Container {
    const container = this.ctx.container;
    if (!container)
      throw new ContainerMisconfigured({
        reason: "HarnessDO has no container: add it to `containers` in the Wrangler configuration",
      });
    return container;
  }
  /**
   * Start the supervisor's container with no Internet access, route its egress hosts to this
   * object, and wait until the supervisor answers. Intercepts last until the container stops.
   */
  private boot() {
    return Effect.gen(this, function* () {
      const container = this.container();
      const image = (container.images as Readonly<Record<string, string>> | undefined)?.[
        HARNESS_IMAGE
      ];
      if (!image)
        return yield* new ContainerMisconfigured({
          reason: `Add an image named "${HARNESS_IMAGE}" to the HarnessDO container entry (scheduling_policy "durable_object")`,
        });
      if (!container.running)
        container.start({ image, instance: this.instance, enableInternet: false });
      const egress = yield* Effect.try({
        try: () =>
          exported<EntrypointLoopback<ContainerEgressProps>>(
            this.ctx,
            "ContainerEgress",
          )({
            props: { harness: this.ctx.id.toString() },
          }),
        catch: (error) =>
          error instanceof ContainerMisconfigured
            ? error
            : new TransportFailure({ operation: "harness.egress", cause: error }),
      });
      yield* io("harness.intercept", async () => {
        for (const host of HARNESS_EGRESS_HOSTS)
          await container.interceptOutboundHttp(host, egress);
        await container.setInactivityTimeout(INACTIVITY_BACKSTOP_MS);
      });
      // Each attempt is bounded, and so is the whole wait: a supervisor that accepts a
      // connection and never answers must not hold the lease's command slot.
      yield* io("harness.ready", async (signal) => {
        const deadline = Date.now() + READY_TIMEOUT_MS;
        for (;;) {
          try {
            const response = await container
              .getTcpPort(SUPERVISOR_PORT)
              .fetch("http://harness/diagnostics", {
                signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
              });
            await releaseBody(response);
            if (response.ok) return;
          } catch (error) {
            if (signal.aborted || Date.now() >= deadline) throw error;
          }
          if (Date.now() >= deadline) throw new Error("The supervisor did not become ready");
          await scheduler.wait(250);
        }
      });
    });
  }
  /** A request to the supervisor in the running container; boots it first if needed. */
  private harnessFetch(operation: string, request: Request | string, init?: RequestInit) {
    return this.lease.acquire.pipe(
      Effect.zipRight(
        io(operation, (signal) =>
          this.container()
            .getTcpPort(SUPERVISOR_PORT)
            .fetch(request, {
              ...init,
              signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal,
            }),
        ),
      ),
    );
  }
  /** Boundary runner: a failure is thrown as itself so its RPC wire name survives. */
  private run<A, E>(program: Effect.Effect<A, E, HarnessServices>): Promise<A> {
    // lint: entrypoint
    return this.runtime.runPromiseExit(program).then(settle);
  }
  /** An entrypoint that uses the container: it stays busy, so no idle check ends it meanwhile. */
  private busy<A, E>(program: Effect.Effect<A, E, HarnessServices>): Promise<A> {
    return this.run(this.lease.hold(program));
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
    containerFetch: (request, init) => this.run(this.harnessFetch("harness.fetch", request, init)),
    child: (subagentId) => this.child(subagentId),
    abortCodeExecutions: () => this.abortCodeExecutions(),
    prepareSandbox: (sandbox, execution) => this.prepareSandbox(sandbox, execution),
  };
  mediaRequest(request: Request): Promise<Response> {
    return this.busy(proxies.mediaRequest(request));
  }
  programmaticRequest(request: Request): Promise<Response> {
    return this.busy(proxies.programmaticRequest(this.host, request));
  }
  mcpRequest(request: Request): Promise<Response> {
    return this.busy(proxies.mcpRequest(this.host, request));
  }
  /**
   * Private route for the parent supervisor: start, poll and control delegated children;
   * see `containers/delegation.ts`.
   */
  delegateRequest(request: Request): Promise<Response> {
    return this.busy(delegateRequest(this.host, request));
  }
  modelRequest(request: Request): Promise<Response> {
    return this.busy(proxies.modelRequest(this.host, request));
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
              yield* rememberSandbox(workspaceOf(this.env, spec.sessionId), {
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
  /** Deployment-owned provisioning of a fresh workspace, before any model call; see `createHarness`. */
  protected async prepareSandbox(_workspace: Workspace, _execution: Execution): Promise<void> {}
  private child(subagentId: string) {
    return this.env.HARNESS.getByName(`${this.ctx.id.toString()}/${subagentId}`);
  }
  /** `sandbox.internal` from the harness container: workspace tools and Codex's `exec-server`. */
  override async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).hostname === "sandbox.internal")
      return this.busy(proxies.sandboxRequest(this.host, request));
    return new Response("Unknown host", { status: 404 });
  }
  startExecution(execution: Execution, operationId: string): Promise<void> {
    return this.busy(
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
      const previousCheckpoint = execution.checkpoint;
      const previousWorkspace = previousCheckpoint?.workspace ?? this.environment.base();
      // A delegated child joins the parent's live sandbox; only the parent resets it.
      if (execution.sandbox && !execution.parent)
        yield* prepareWorkspace(this.host, execution, previousWorkspace);
      if (execution.sandbox && harness === "codex") yield* ensureCodexServer(execution.sessionId);
      const capabilityRoots = execution.parent
        ? [...(execution.capabilityRoots ?? [])]
        : this.environment.capabilityRoots();
      let portableInstructions = "";
      if (harness !== "codex" && execution.sandbox) {
        const attached = yield* attachCapabilities(execution, assigned.mcp ?? [], capabilityRoots);
        portableInstructions = attached.instructions;
        assigned.mcp = attached.mcp;
      }
      const checkpoint = yield* loadCheckpoint(previousCheckpoint);
      yield* this.lease.acquire;
      // Durable dispatch tombstone: retries may inspect, but cannot replay a lost job. The
      // marker and the dispatch it describes are one uninterruptible step: an interrupt
      // between them, or mid-request, would leave a marker for a job that never started.
      const result = yield* Effect.uninterruptible(
        write((tx) => tx.putAssignment({ ...assigned, dispatched: true })).pipe(
          Effect.zipRight(
            this.harnessFetch("startAttempt", "http://harness/jobs", {
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
      );
      // The job is dispatched either way; the body carries nothing more.
      yield* io("startAttempt.release", () => releaseBody(result)).pipe(Effect.ignore);
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
    return this.busy(
      Effect.gen(this, function* () {
        const current = yield* assignment;
        if (superseded(current, execution))
          return Response.json({ status: "missing", events: [], cursor: 0 });
        // The turn uses its sandbox through sockets this object does not see; keep it alive.
        if (
          current.sandbox &&
          !current.parent &&
          Date.now() - this.sandboxTouched > SANDBOX_TOUCH_MS
        ) {
          this.sandboxTouched = Date.now();
          yield* io("pollExecution.sandbox", () =>
            sandboxOf(this.env, current.sessionId).touch(),
          ).pipe(Effect.ignore);
        }
        const wait =
          current.dispatched && !current.revoked
            ? Math.min(Math.max(0, Math.floor(waitMs)), LONG_POLL_MAX_MS)
            : 0;
        return yield* this.harnessFetch(
          "pollExecution",
          `http://harness/jobs/${execution.turnId}?after=${after}${wait > 0 ? `&wait=${wait}` : ""}`,
        );
      }),
    );
  }
  controlExecution(
    execution: Execution,
    operationId: string,
    command: RuntimeCommand,
  ): Promise<void> {
    return this.busy(
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
        const result = yield* this.harnessFetch(
          "controlExecution",
          `http://harness/jobs/${execution.turnId}/control`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ operationId, command }),
          },
        );
        if (command.type === "cancel") this.abortCodeExecutions();
        if (result.ok)
          yield* io("controlExecution.release", () => releaseBody(result)).pipe(Effect.ignore);
        else {
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
    return this.busy(
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
      // Native stderr is lost with the container; keep a bounded tail in Worker logs. A
      // container that is gone has nothing to say, and is not started to say it.
      if (current.dispatched && this.ctx.container?.running)
        yield* io("stopAttempt.diagnostics", async (signal) => {
          const response = await this.container()
            .getTcpPort(SUPERVISOR_PORT)
            .fetch("http://harness/diagnostics", {
              signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
            });
          if (!response.ok) return releaseBody(response);
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
      yield* this.lease.stop("turn stopped");
      if (current.sandbox && !current.parent) {
        // Uncommitted workspace state is discarded; the next turn restores the last checkpoint.
        yield* write((tx) => tx.forgetSandbox());
        yield* io("stopAttempt", () =>
          sandboxOf(this.env, execution.sessionId).stop("turn stopped"),
        );
      }
    });
  }
  /**
   * The session was deleted: revoke the assignment, then retire the delegated children's
   * containers, this one, and the sandbox it owns. A retired object never starts a
   * container again. Deletion is refused while a turn is active, so nothing here discards
   * uncommitted work.
   */
  releaseCompute(): Promise<void> {
    return this.run(
      this.lifecycle.withPermits(1)(
        this.workspace.withPermits(1)(
          Effect.gen(this, function* () {
            this.abortCodeExecutions();
            const current = yield* read((tx) => tx.assignment());
            if (current && !current.revoked)
              yield* write((tx) => tx.putAssignment({ ...current, revoked: true }));
            for (const subagentId of current?.children ?? [])
              yield* io("releaseCompute.child", () => this.child(subagentId).releaseCompute()).pipe(
                Effect.ignore,
              );
            yield* this.lease.retire;
            if (current?.parent) return;
            // A session prepared before its first turn has a sandbox but no assignment yet.
            const sessionId = current?.sessionId ?? this.ctx.id.name;
            if (!sessionId) return;
            yield* write((tx) => tx.forgetSandbox());
            yield* io("releaseCompute", () => sandboxOf(this.env, sessionId).release());
          }),
        ),
      ),
    );
  }
  /** The lease's timers: the idle check that ends an unused container. */
  override alarm(): Promise<void> {
    return this.run(this.lease.wake);
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

/** Deployment-owned provisioning runs once per fresh workspace, before any model call. */
export function createHarness<Env extends ContainerBindings>(
  prepare: (workspace: Workspace, execution: Execution, env: Env) => Promise<void>,
): typeof HarnessContainer<Env> {
  return class ConfiguredHarness extends HarnessContainer<Env> {
    protected override prepareSandbox(workspace: Workspace, execution: Execution): Promise<void> {
      return prepare(workspace, execution, this.env);
    }
  };
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
    release: async (sessionId) => {
      await env.HARNESS.getByName(sessionId).releaseCompute();
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
