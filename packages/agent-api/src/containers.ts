import { Container } from "@cloudflare/containers";
import { getSandbox, type ISandbox, Sandbox } from "@cloudflare/sandbox";
import { Context, Effect, Layer, ManagedRuntime, Schema, Stream } from "effect";
import { z } from "zod";

import type { CatalogObject } from "./catalog.js";
import { EnvironmentWorkspace, type ExportedEnvironment } from "./container-environments.js";
import { attempt, decode, decodeEffect, io, type ServiceError, settle } from "./effect.js";
import type { HostedConfiguration } from "./environment-config.js";
import { environmentMcpScript } from "./environment-mcp.js";
import type { EnvironmentDriver } from "./environments.js";
import { CommandRejected, ExecutionMissing, TransportFailure } from "./errors.js";
import { copyKnownLength } from "./files.js";
import { HARNESSES, type HarnessName } from "./harnesses.js";
import { proxyMcp } from "./mcp.js";
import { fetchAssignedImage } from "./media.js";
import { readModelBody } from "./models/body.js";
import { constrainCodexSearch } from "./models/codex-search.js";
import type { Assignment, SandboxState } from "./persistence/harness-kinds.js";
import {
  type HarnessRepository,
  type HarnessTx,
  makeHarnessRepo,
  makeHarnessTx,
} from "./persistence/harness-tx.js";
import type { Sync } from "./persistence/repo.js";
import { discoverCapabilities } from "./portable-capabilities.js";
import { programmaticInputSchema } from "./programmatic-contract.js";
import { runProgrammatic } from "./programmatic.js";
import { ApiError } from "./protocol.js";
import type { Checkpoint, Execution, RuntimeCommand, RuntimeDriver } from "./runtime.js";
import { batchSchema, commandSchema, fromPromiseDriver } from "./runtime.js";
import { executeWorkspaceTool } from "./sandbox-tools.js";
import { SqlStore } from "./storage.js";
import { workspaceTools } from "./workspace.js";

export interface ContainerBindings {
  HARNESS: DurableObjectNamespace<HarnessContainer>;
  SANDBOX: DurableObjectNamespace<SandboxContainer>;
  CHECKPOINTS: R2Bucket;
  BACKUP_BUCKET: R2Bucket;
  MODEL_GATEWAY: Fetcher;
  CODE_LOADER?: WorkerLoader;
  /** Optional trusted service that sends configured service-origin MCP requests. */
  MCP?: Fetcher;
  LOCAL_BACKUPS?: string;
  CATALOG: DurableObjectNamespace<CatalogObject>;
}
const SANDBOX_MARKER = "/tmp/cf-open-agents-sandbox.json";
const IMAGE_DIGEST_LIMIT = 256;
const spawnRequestSchema = z.object({
  alias: z.string().min(1),
  prompt: z.string().min(1).max(128_000),
  name: z.string().max(256).nullable().optional(),
});
const IMAGE_DATA_PREFIX = "data:";
async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
function remoteImageURLs(parts: readonly { type: string; image_url?: string }[]): string[] {
  return parts.flatMap((part) =>
    part.type === "input_image" && part.image_url && !part.image_url.startsWith(IMAGE_DATA_PREFIX)
      ? [part.image_url]
      : [],
  );
}

export class SandboxContainer extends Sandbox<ContainerBindings> {
  override sleepAfter = "10m";
  constructor(ctx: ConstructorParameters<typeof Sandbox>[0], env: ContainerBindings) {
    super(ctx, env);
    // Internet access is enabled unless the environment's network policy disabled it.
    // The policy is stored before the Container starts (see configureNetwork).
    // The runtime awaits this; the constructor itself cannot.
    void ctx.blockConcurrencyWhile(async () => {
      this.enableInternet = (await ctx.storage.get<boolean>("environment_internet")) ?? true;
    });
  }
  async configureNetwork(network: HostedConfiguration["network"]): Promise<void> {
    const access = network?.access ?? "enabled";
    const enabled = access === "enabled";
    if (this.ctx.container?.running && this.enableInternet !== enabled)
      throw new ApiError(
        409,
        "network_policy_conflict",
        "Network access must be configured before the environment starts",
      );
    await this.ctx.storage.put("environment_internet", enabled);
    this.enableInternet = enabled;
    await this.setAllowedHosts(
      access === "enabled"
        ? ["*"]
        : access === "restricted"
          ? (network?.allowed_domains ?? [])
          : [],
    );
    await this.setDeniedHosts(access === "disabled" ? ["*"] : []);
  }
  override async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).hostname === "sandbox.internal")
      return this.containerFetch(request, 4500);
    if (new URL(request.url).hostname === "environment-mcp.internal")
      return this.containerFetch(request, 4501);
    return super.fetch(request);
  }
}

/** The two services a HarnessDO program needs; both are built once per object. */
export class HarnessRepo extends Context.Tag("agent-api/HarnessRepo")<
  HarnessRepo,
  HarnessRepository
>() {}
export class HarnessBindings extends Context.Tag("agent-api/HarnessBindings")<
  HarnessBindings,
  ContainerBindings
>() {}
export type HarnessServices = HarnessRepo | HarnessBindings;
const read = <A>(f: (tx: HarnessTx) => Sync<A>) =>
  Effect.flatMap(HarnessRepo, (repo) => repo.read(f));
const write = <A>(f: (tx: HarnessTx) => Sync<A>) =>
  Effect.flatMap(HarnessRepo, (repo) => repo.transaction(f));
const assignment = read((tx) => tx.requireAssignment());
/** The durable execution identity moved on since `expected` was read. */
const superseded = (
  current: Pick<Assignment, "turnId" | "generation">,
  expected: Pick<Assignment, "turnId" | "generation">,
) => current.turnId !== expected.turnId || current.generation !== expected.generation;
/** The bounded set of remote image URLs a turn may fetch, as digests; excess is an explicit error. */
const imageDigests = (urls: readonly string[], existing: readonly string[]) =>
  Effect.gen(function* () {
    const digests = yield* io("assignment.images", () => Promise.all(urls.map(sha256Hex)));
    const merged = [...new Set([...existing, ...digests])];
    if (merged.length > IMAGE_DIGEST_LIMIT)
      return yield* new ApiError(
        413,
        "image_limit",
        `A turn may reference at most ${IMAGE_DIGEST_LIMIT} remote images`,
      );
    return merged;
  });
/** Code may call client functions, workspace tools and tools of configured MCP servers only. */
function permittedCodeTool(current: Assignment, name: string): boolean {
  if (!current.programmatic) return false;
  if (current.programmatic.tools.includes(name)) return true;
  return (current.mcp ?? []).some((tool) => name.startsWith(`mcp__${tool.server_label}__`));
}
/** Long-poll bound the supervisor accepts; the HarnessDO stays under its fetch timeout. */
const LONG_POLL_MAX_MS = 25_000;
const ARTIFACT_FILE_LIMIT = 200 * 1024 * 1024;
const ARTIFACT_TURN_LIMIT = 500 * 1024 * 1024;
/**
 * Publish `/workspace/outputs` to R2 under a durable manifest: the manifest is committed
 * before any upload, so a retry uploads the same ids, and uploads that already exist are
 * skipped. Four files transfer at a time; each copy handles its own interruption.
 */
const publishArtifacts = Effect.fn("harness.artifacts")(function* (execution: Execution) {
  const env = yield* HarnessBindings;
  const sandbox = getSandbox(env.SANDBOX, execution.sessionId);
  if (!(yield* io("artifact.exists", () => sandbox.exists("/workspace/outputs"))).exists) return [];
  let manifest = yield* read((tx) => tx.artifacts(execution.generation));
  if (!manifest) {
    const listing = yield* io("artifact.list", () =>
      sandbox.listFiles("/workspace/outputs", { recursive: true, includeHidden: true }),
    );
    if (!listing.success)
      return yield* new ApiError(503, "artifact_list_failed", "Artifact listing failed");
    const files = listing.files.filter((file) => file.type === "file");
    if (
      files.some((file) => file.size > ARTIFACT_FILE_LIMIT) ||
      files.reduce((sum, file) => sum + file.size, 0) > ARTIFACT_TURN_LIMIT
    )
      return yield* new ApiError(
        413,
        "artifact_limit",
        "Artifacts exceed 200 MiB per file or 500 MiB per turn",
      );
    const created_at = Math.floor(Date.now() / 1000);
    manifest = yield* Effect.forEach(files, (file) =>
      Effect.map(
        io("artifact.hash", () =>
          crypto.subtle.digest(
            "SHA-256",
            new TextEncoder().encode(`${execution.turnId}\0${file.absolutePath}`),
          ),
        ),
        (hash) => {
          const id = `artifact_${Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
          return {
            id,
            key: `artifacts/${execution.sessionId}/${id}`,
            path: file.absolutePath,
            size_bytes: file.size,
            session_id: execution.sessionId,
            environment_id: execution.environmentId ?? "",
            turn_id: execution.turnId,
            created_at,
          };
        },
      ),
    );
    const built = manifest;
    yield* write((tx) => tx.putArtifacts(execution.generation, built));
  }
  yield* Effect.forEach(
    manifest,
    (artifact) =>
      Effect.gen(function* () {
        if (yield* io("artifact.head", () => env.CHECKPOINTS.head(artifact.key))) return;
        const source = yield* io("artifact.read", () =>
          sandbox.readFile(artifact.path, { encoding: "none" }),
        );
        yield* copyKnownLength(source.content, artifact.size_bytes, (stream) =>
          env.CHECKPOINTS.put(artifact.key, stream, {
            httpMetadata: { contentType: "application/octet-stream" },
          }),
        );
      }),
    { concurrency: 4, discard: true },
  );
  return manifest;
});

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
    return this.runtime.runPromiseExit(program).then(settle);
  }
  private abortCodeExecutions(): void {
    for (const controller of this.codeExecutions) controller.abort();
  }
  mediaRequest(request: Request): Promise<Response> {
    return this.run(
      Effect.gen(function* () {
        const current = yield* assignment;
        const url = new URL(request.url);
        const source = url.searchParams.get("url");
        const refused = new Response("Image is not assigned to this execution", { status: 403 });
        if (request.method !== "GET" || url.pathname !== "/image" || current.revoked || !source)
          return refused;
        const digest = yield* io("assignment.image", () => sha256Hex(source));
        if (!current.imageDigests?.includes(digest)) return refused;
        return yield* io("assignment.image", () => fetchAssignedImage(source, request.signal));
      }),
    );
  }
  programmaticRequest(request: Request): Promise<Response> {
    return this.run(
      Effect.gen(this, function* () {
        const current = yield* assignment;
        const loader = this.env.CODE_LOADER;
        if (
          request.method !== "POST" ||
          new URL(request.url).pathname !== `/${current.turnId}` ||
          !current.programmatic ||
          current.revoked ||
          !loader
        )
          return new Response("No code runner assigned", { status: 403 });
        const programmatic = current.programmatic;
        // Other entrypoints (a newer start, a cancel, a stop) abort running code through
        // this controller; the request's own fiber ends it when the response is built.
        const controller = new AbortController();
        this.codeExecutions.add(controller);
        const execute = Effect.gen(this, function* () {
          const input = yield* io("programmatic.input", async () =>
            programmaticInputSchema.parse(await request.json()),
          );
          const invocation = yield* attempt("programmatic.invocation", () =>
            z.string().uuid().parse(request.headers.get("x-cf-code-invocation")),
          );
          const catalog = yield* io("programmatic.catalog", () =>
            this.containerFetch(
              `http://harness/jobs/${current.turnId}/code-tools?invocation=${invocation}`,
            ),
          );
          if (!catalog.ok)
            return yield* new TransportFailure({
              operation: "programmatic.catalog",
              cause: "Code tool catalog is unavailable",
            });
          // The container proposes names; the Worker's assignment decides what code may call.
          const tools = yield* io("programmatic.tools", async () =>
            z
              .array(z.string().min(1).max(256))
              .max(2000)
              .parse(await catalog.json())
              .filter((name) => permittedCodeTool(current, name)),
          );
          return yield* io("programmatic.run", () =>
            runProgrammatic(loader, {
              input,
              tools,
              signal: controller.signal,
              timeoutMs: programmatic.deadline - Date.now(),
              call: async (name, args, signal) => {
                // The runtime calls back outside any fiber: the synchronous view answers.
                const latest = this.tx.requireAssignment();
                if (latest.revoked || superseded(latest, current))
                  throw new Error("Execution was superseded");
                if (!permittedCodeTool(latest, name)) throw new Error("Tool is not allowed");
                const result = await this.containerFetch(
                  new Request(`http://harness/jobs/${current.turnId}/code-tool`, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ name, arguments: args, invocation }),
                    signal,
                  }),
                );
                if (!result.ok) throw new Error("Programmatic tool call failed");
                return result.json();
              },
            }),
          );
        });
        const failed = (error: ServiceError) =>
          Effect.gen(this, function* () {
            const cause = error._tag === "OperationError" ? error.cause : error;
            const terminal =
              cause instanceof ApiError && cause.code === "programmatic_execution_uncertain";
            if (terminal) {
              // A child reports the uncertain outcome; its parent's failure destroys the shared sandbox.
              const revoked = yield* write((tx) => {
                const latest = tx.requireAssignment();
                if (superseded(latest, current)) return false;
                tx.putAssignment({ ...latest, revoked: true });
                if (current.sandbox && !current.parent) tx.forgetSandbox();
                return true;
              });
              if (revoked && current.sandbox && !current.parent)
                yield* io("programmatic.destroy", () =>
                  getSandbox(this.env.SANDBOX, current.sessionId).destroy(),
                );
            }
            return Response.json({
              content: [
                {
                  type: "text",
                  text: cause instanceof ApiError ? cause.message : "Code execution failed",
                },
              ],
              isError: true,
              terminal,
            });
          });
        return yield* execute.pipe(
          Effect.map((value) =>
            Response.json({
              content: [{ type: "text", text: JSON.stringify(value) }],
              isError: false,
            }),
          ),
          Effect.catchAll(failed),
          Effect.ensuring(
            Effect.sync(() => {
              controller.abort();
              this.codeExecutions.delete(controller);
            }),
          ),
        );
      }),
    );
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
              yield* this.rememberSandbox(getSandbox(this.env.SANDBOX, spec.sessionId), {
                workspaceId: base.id,
                provisioned: this.environment.inherited(),
              });
            }),
          ),
        ),
      ),
    );
  }
  /** Record the workspace the live filesystem holds, inside the container and durably. */
  private rememberSandbox(sandbox: ISandbox, state: SandboxState) {
    return Effect.gen(function* () {
      const written = yield* io("sandbox.marker", () =>
        sandbox.writeFile(SANDBOX_MARKER, JSON.stringify({ workspaceId: state.workspaceId })),
      );
      if (!written.success)
        return yield* new TransportFailure({
          operation: "sandbox.marker",
          cause: "Sandbox marker write failed",
        });
      yield* write((tx) => tx.rememberSandbox(state));
    });
  }
  /** True when the running sandbox provably holds `workspaceId`; any doubt means restore. */
  private sandboxHolds(sandbox: ISandbox, sessionId: string, workspaceId: string) {
    return Effect.gen(this, function* () {
      const state = yield* read((tx) => tx.sandbox());
      if (!state || state.workspaceId !== workspaceId) return false;
      const runtime = yield* io(
        "sandbox.status",
        async () => await this.env.SANDBOX.getByName(sessionId).getState(),
      ).pipe(Effect.option);
      const status = runtime._tag === "Some" ? runtime.value.status : undefined;
      if (status !== "running" && status !== "healthy") return false;
      const marker = yield* io("sandbox.marker.read", () => sandbox.readFile(SANDBOX_MARKER)).pipe(
        Effect.option,
      );
      if (marker._tag === "None" || !marker.value.success) return false;
      return yield* attempt("sandbox.marker.decode", () => {
        const parsed: unknown = JSON.parse(marker.value.content);
        return (
          typeof parsed === "object" &&
          parsed !== null &&
          "workspaceId" in parsed &&
          parsed.workspaceId === workspaceId
        );
      }).pipe(Effect.orElseSucceed(() => false));
    });
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
  mcpRequest(request: Request): Promise<Response> {
    return this.run(
      Effect.gen(this, function* () {
        const current = yield* assignment;
        if (current.revoked)
          return new Response("Execution authority was revoked", { status: 409 });
        const tool = current.mcp?.find(
          (entry) => `/${entry.server_label}` === new URL(request.url).pathname,
        );
        if (!tool) return new Response(null, { status: 404 });
        if (tool.transport.type === "stdio" || tool.connection_origin === "environment") {
          if (!current.sandbox || current.harness === "codex")
            return new Response(null, { status: 404 });
          const url = new URL(request.url);
          url.hostname = "environment-mcp.internal";
          return yield* io("mcp.environment", (signal) =>
            this.env.SANDBOX.getByName(current.sessionId).fetch(
              new Request(new Request(url, request), {
                signal: AbortSignal.any([request.signal, signal]),
              }),
            ),
          );
        }
        const serverURL = tool.transport.server_url;
        const tenant = current.tenant;
        const token = tenant
          ? yield* io("mcp.credential", () =>
              this.env.CATALOG.getByName(tenant).mcpToken(
                [...(current.vaultIds ?? [])],
                serverURL,
                tool.credential_id,
              ),
            )
          : undefined;
        const sender = this.env.MCP;
        return yield* proxyMcp(
          request,
          tool,
          token,
          sender ? (outbound) => sender.fetch(outbound) : fetch,
        );
      }),
    );
  }
  private child(subagentId: string) {
    return this.env.HARNESS.getByName(`${this.ctx.id.toString()}/${subagentId}`);
  }
  /**
   * Private route for the parent supervisor: start, poll and control delegated
   * children. Children run in their own HarnessDO and Container but share the
   * parent's sandbox; the parent's assignment remains the authorization boundary.
   */
  delegateRequest(request: Request): Promise<Response> {
    return this.run(
      Effect.gen(this, function* () {
        const current = yield* assignment;
        const url = new URL(request.url);
        const [turnId, target, action] = url.pathname.split("/").slice(1);
        const delegation = current.delegation;
        if (current.revoked || turnId !== current.turnId || !delegation)
          return new Response("Delegation is not available for this execution", { status: 403 });
        if (request.method === "POST" && target === "spawn" && !action)
          return yield* this.spawnChild(
            current,
            delegation,
            yield* io("delegate.body", () => request.json()),
          );
        if (!target) return new Response(null, { status: 404 });
        const child = yield* read((tx) => tx.child(target));
        if (!child || child.execution.parent?.turnId !== turnId)
          return new Response("Unknown subagent", { status: 404 });
        if (request.method === "GET" && !action) {
          if (child.terminal) return Response.json(child.terminal);
          const after = yield* attempt("delegate.cursor", () =>
            z.coerce
              .number()
              .int()
              .min(0)
              .parse(url.searchParams.get("after") ?? "0"),
          );
          const polled = yield* io("delegate.poll", () =>
            this.child(target).pollExecution(child.execution, after),
          );
          const batch = yield* decodeEffect(
            batchSchema,
            yield* io("delegate.poll", () => polled.json()),
          );
          if (batch.status !== "running" && batch.status !== "waiting") {
            // Durable before the child Container disappears, so a lost response can be retried.
            yield* write((tx) => tx.putChild(target, { ...child, terminal: batch }));
            yield* io("delegate.stop", () =>
              this.child(target).stopExecution(child.execution),
            ).pipe(
              Effect.catchAll((error) =>
                Effect.logWarning("Delegated child stop failed", { error: String(error) }),
              ),
            );
          }
          return Response.json(batch);
        }
        if (request.method === "POST" && action === "control") {
          if (child.terminal) return new Response("Subagent has stopped", { status: 409 });
          const body = yield* decodeEffect(
            Schema.Struct({ operationId: Schema.String, command: commandSchema }),
            yield* io("delegate.body", () => request.json()),
          );
          yield* io("delegate.control", () =>
            this.child(target).controlExecution(child.execution, body.operationId, body.command),
          );
          return new Response(null, { status: 204 });
        }
        return new Response(null, { status: 404 });
      }),
    );
  }
  private spawnChild(
    current: Assignment,
    delegation: NonNullable<Assignment["delegation"]>,
    input: unknown,
  ) {
    return Effect.gen(this, function* () {
      const parsed = spawnRequestSchema.safeParse(input);
      if (!parsed.success) return new Response("Invalid spawn request", { status: 400 });
      const delegate = delegation.delegates.find((entry) => entry.alias === parsed.data.alias);
      if (!delegate) return new Response("Unknown delegate", { status: 404 });
      const children = current.children ?? [];
      const active = yield* read((tx) => children.filter((id) => !tx.child(id)?.terminal).length);
      if (active >= delegation.maxConcurrentSubagents)
        return new Response("Concurrent subagent limit reached", { status: 409 });
      const subagentId = `subagent_${crypto.randomUUID().replaceAll("-", "")}`;
      const turnId = `turn_${crypto.randomUUID().replaceAll("-", "")}`;
      const execution: Execution = {
        sessionId: current.sessionId,
        turnId,
        generation: current.generation,
        harness: delegate.harness,
        model: delegate.model,
        agent: {
          model: delegate.alias,
          instructions: delegation.agent.instructions ?? null,
          // Children keep the parent's client, MCP and code tools; provider search follows the child runtime.
          tools: (delegation.agent.tools ?? []).filter(
            (tool) => tool.type !== "web_search" || delegate.harness === "codex",
          ),
          reasoning: delegation.agent.reasoning ?? null,
          multi_agent: { enabled: false },
        },
        input: [{ role: "user", content: [{ type: "input_text", text: parsed.data.prompt }] }],
        checkpoint: null,
        deadline: delegation.deadline,
        sandbox: current.sandbox,
        ...(delegation.environmentId ? { environmentId: delegation.environmentId } : {}),
        capabilityRoots: this.environment.capabilityRoots(),
        ...(current.tenant ? { tenant: current.tenant } : {}),
        ...(current.vaultIds ? { vaultIds: [...current.vaultIds] } : {}),
        parent: { turnId: current.turnId, subagentId },
      };
      yield* write((tx) => {
        tx.putChild(subagentId, { execution });
        tx.putAssignment({ ...current, children: [...children, subagentId] });
      });
      const started = yield* io("delegate.start", () =>
        this.child(subagentId).startExecution(execution, `${turnId}:start`),
      ).pipe(Effect.either);
      if (started._tag === "Left") {
        yield* Effect.logWarning("Delegated child start failed", {
          subagentId,
          error: String(started.left),
        });
        yield* write((tx) =>
          tx.putChild(subagentId, {
            execution,
            terminal: { status: "failed", events: [], cursor: 0, error: "subagent_start_failed" },
          }),
        );
        yield* io("delegate.stop", () => this.child(subagentId).stopExecution(execution)).pipe(
          Effect.ignore,
        );
        return new Response("Subagent could not be started", { status: 502 });
      }
      return Response.json({ subagentId, turnId });
    });
  }
  override async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).hostname === "sandbox.internal")
      return this.run(this.sandboxRequest(request));
    return super.fetch(request);
  }
  private sandboxRequest(request: Request) {
    return Effect.gen(this, function* () {
      const current = yield* assignment;
      if (current.revoked) return new Response("Execution authority was revoked", { status: 409 });
      if (!current.sandbox) return new Response("No sandbox assigned", { status: 403 });
      if (new URL(request.url).pathname !== "/tools" || request.method !== "POST")
        return yield* io("sandbox.proxy", () =>
          this.env.SANDBOX.getByName(current.sessionId).fetch(request),
        );
      const input = yield* io("workspace.tool.body", () => request.json());
      const operation = (onOutput?: (text: string) => void) =>
        this.workspace.withPermits(1)(
          io("workspace.tool", async (signal) => {
            const latest = this.tx.requireAssignment();
            if (latest.revoked || superseded(latest, current))
              throw new ApiError(409, "stale_generation", "Execution was superseded");
            signal.throwIfAborted();
            return executeWorkspaceTool(
              getSandbox(this.env.SANDBOX, current.sessionId),
              input,
              onOutput ? { onOutput, signal } : undefined,
            );
          }),
        );
      if (request.headers.get("accept") !== "application/x-ndjson")
        return yield* operation().pipe(
          Effect.map((result) => Response.json(result)),
          Effect.orElseSucceed(() =>
            Response.json({ error: "Workspace operation failed" }, { status: 422 }),
          ),
        );
      const line = (value: unknown) => `${JSON.stringify(value)}\n`;
      // The response stream owns the operation: cancelling it interrupts the fiber, which
      // aborts the command through the signal and releases the workspace permit.
      const lines = Stream.asyncPush<string>((emit) =>
        Effect.forkScoped(
          operation((text) => emit.single(line({ type: "delta", text }))).pipe(
            Effect.match({
              onSuccess: (result) => emit.single(line({ type: "result", ...result })),
              onFailure: () =>
                emit.single(line({ type: "error", message: "Workspace operation failed" })),
            }),
            Effect.ensuring(Effect.sync(() => emit.end())),
          ),
        ),
      );
      const body = yield* Stream.toReadableStreamEffect(lines.pipe(Stream.encodeText));
      return new Response(body, { headers: { "content-type": "application/x-ndjson" } });
    });
  }
  modelRequest(request: Request): Promise<Response> {
    return this.run(
      Effect.gen(this, function* () {
        const current = yield* assignment;
        if (current.revoked)
          return new Response("Execution authority was revoked", { status: 409 });
        const url = new URL(request.url);
        if (request.method !== "POST" || url.pathname !== HARNESSES[current.harness].protocol)
          return new Response("Unsupported model request", { status: 403 });
        const bytes = yield* io("modelRequest", () => readModelBody(request));
        const body = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
        if (!body || body.model !== current.model)
          return new Response("Model is not assigned to this execution", { status: 403 });
        const latest = yield* assignment;
        if (superseded(latest, current))
          return new Response("Execution was superseded", { status: 409 });
        return yield* io("modelRequest", (signal) =>
          this.env.MODEL_GATEWAY.fetch(
            new Request(request, {
              body:
                current.harness === "codex" && current.webSearchMode !== undefined
                  ? JSON.stringify(constrainCodexSearch(body, current.webSearchMode))
                  : bytes,
              signal: AbortSignal.any([request.signal, signal]),
            }),
          ),
        );
      }),
    );
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
      if (!Object.hasOwn(HARNESSES, execution.harness))
        return yield* new ApiError(400, "unsupported_harness", "Unknown Container harness");
      const harness = execution.harness as HarnessName;
      if (
        execution.checkpoint &&
        (execution.checkpoint.driver !== harness ||
          execution.checkpoint.revision !== HARNESSES[harness].revision)
      )
        return yield* new ApiError(
          409,
          "checkpoint_incompatible",
          "Checkpoint belongs to another harness version",
        );
      const previous = yield* read((tx) => tx.assignment());
      if (
        previous &&
        (execution.generation < previous.generation ||
          (execution.generation === previous.generation && execution.turnId !== previous.turnId))
      )
        return yield* new ApiError(409, "stale_generation", "Execution was superseded");
      if (previous?.turnId === execution.turnId && previous.dispatched) return;
      if (previous && previous.sessionId !== execution.sessionId)
        return yield* new ApiError(
          409,
          "assignment_conflict",
          "Container already belongs to another session",
        );
      const assigned: Assignment = {
        sessionId: execution.sessionId,
        generation: execution.generation,
        turnId: execution.turnId,
        model: execution.model,
        ...(harness === "codex"
          ? {
              webSearchMode: execution.agent.tools?.some((tool) => tool.type === "web_search")
                ? (execution.agent.tools.find((tool) => tool.type === "web_search")?.mode ?? "live")
                : "disabled",
            }
          : {}),
        harness,
        dispatched: false,
        sandbox: execution.sandbox,
        tenant: execution.tenant,
        vaultIds: execution.vaultIds,
        mcp: (execution.agent.tools ?? []).filter((tool) => tool.type === "mcp"),
        imageDigests: yield* imageDigests(
          remoteImageURLs(execution.input.flatMap((message) => message.content)),
          [],
        ),
        ...(execution.agent.tools?.some(
          (tool) => tool.type === "programmatic_tool_calling" && tool.enabled !== false,
        )
          ? {
              programmatic: {
                tools: [
                  ...execution.agent.tools
                    .filter((tool) => tool.type === "function")
                    .map((tool) => tool.name),
                  ...(execution.sandbox ? Object.keys(workspaceTools) : []),
                ],
                deadline: execution.deadline,
              },
            }
          : {}),
        ...(execution.delegates?.length && !execution.parent
          ? {
              delegation: {
                delegates: execution.delegates,
                maxConcurrentSubagents: execution.maxConcurrentSubagents ?? 6,
                agent: execution.agent,
                deadline: execution.deadline,
                ...(execution.environmentId ? { environmentId: execution.environmentId } : {}),
              },
            }
          : {}),
        ...(execution.parent ? { parent: execution.parent } : {}),
      };
      this.abortCodeExecutions();
      yield* write((tx) => tx.putAssignment(assigned));
      const sandbox = getSandbox(this.env.SANDBOX, execution.sessionId);
      const previousCheckpoint = execution.checkpoint;
      const previousWorkspace = previousCheckpoint?.workspace ?? this.environment.base();
      // A delegated child joins the parent's live sandbox; only the parent resets it.
      const listening = (port: number) =>
        io("startAttempt.probe", async () => {
          const probe = await sandbox.exec([
            "bash",
            "-c",
            `exec 3<>/dev/tcp/127.0.0.1/${port} 2>/dev/null && echo up || echo down`,
          ]);
          return (await probe.output({ timeout: 10_000, encoding: "utf8" })).stdout.includes("up");
        });
      if (execution.sandbox && !execution.parent) {
        const workspaceId = previousWorkspace?.id ?? "";
        // A running sandbox that provably holds the committed workspace continues as is,
        // including state outside /workspace. Anything else starts from the last committed
        // filesystem checkpoint: destroy, restore, and configure the fresh container.
        const reused = yield* this.sandboxHolds(sandbox, execution.sessionId, workspaceId);
        if (!reused) {
          yield* write((tx) => tx.forgetSandbox());
          yield* io("startAttempt", () => sandbox.destroy());
          if (previousWorkspace)
            yield* io("startAttempt", () => sandbox.restoreBackup(previousWorkspace));
          else {
            yield* io("startAttempt", () => sandbox.mkdir("/workspace", { recursive: true }));
          }
          const environmentSpec = this.environment.spec();
          if (environmentSpec) yield* this.environment.configure(environmentSpec);
          yield* this.rememberSandbox(sandbox, {
            workspaceId,
            provisioned: previousCheckpoint !== null || this.environment.inherited(),
          });
        }
        // The deployment hook runs once per fresh workspace; an inherited workspace was provisioned.
        if (!(yield* read((tx) => tx.sandbox()))?.provisioned) {
          yield* io("startAttempt", () => this.prepareSandbox(sandbox, execution));
          yield* this.rememberSandbox(sandbox, { workspaceId, provisioned: true });
        }
        yield* this.environment.applyUploads(previousCheckpoint?.environmentFileVersion ?? 0);
      }
      if (execution.sandbox && harness === "codex" && !(yield* listening(4500))) {
        const executor = yield* io("startAttempt", () =>
          sandbox.exec(["codex", "exec-server", "--listen", "ws://0.0.0.0:4500"]),
        );
        yield* io("startAttempt", () => executor.waitForPort(4500));
      }
      const capabilityRoots = execution.parent
        ? [...(execution.capabilityRoots ?? [])]
        : this.environment.capabilityRoots();
      let portableInstructions = "";
      if (harness !== "codex" && execution.sandbox) {
        const configured = assigned.mcp ?? [];
        // Plugin-derived labels are sanitized and kept distinct from configured servers, so
        // workspace content can add servers but never replace or break configured ones.
        const discovered = yield* io("capabilities.discover", () =>
          discoverCapabilities(sandbox, capabilityRoots, {
            reservedLabels: configured.map((entry) => entry.server_label),
            diagnostics: (line) =>
              console.warn("Capability discovery skipped an entry", {
                sessionId: execution.sessionId,
                line,
              }),
          }),
        );
        portableInstructions = discovered.instructions;
        assigned.mcp = [...configured, ...discovered.mcp];
        const environmentServers = assigned.mcp.filter(
          (tool) => tool.transport.type === "stdio" || tool.connection_origin === "environment",
        );
        if (environmentServers.length && !(yield* listening(4501))) {
          yield* io("mcp.bridge.config", () =>
            sandbox.writeFile(
              "/tmp/cf-environment-mcp.json",
              JSON.stringify(
                Object.fromEntries(
                  environmentServers.map((tool) => [tool.server_label, tool.transport]),
                ),
              ),
            ),
          );
          yield* io("mcp.bridge.script", () =>
            sandbox.writeFile("/tmp/cf-environment-mcp.mjs", environmentMcpScript),
          );
          const bridge = yield* io("mcp.bridge.start", () =>
            sandbox.exec(["node", "/tmp/cf-environment-mcp.mjs", "/tmp/cf-environment-mcp.json"]),
          );
          yield* io("mcp.bridge.ready", () => bridge.waitForPort(4501));
        }
      }
      let checkpoint: unknown;
      if (previousCheckpoint) {
        const object = yield* io("startAttempt", () =>
          this.env.CHECKPOINTS.get(previousCheckpoint.native),
        );
        if (!object)
          return yield* new ApiError(409, "checkpoint_missing", "Native checkpoint is missing");
        checkpoint = yield* io("startAttempt", () => object.json());
      }
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
                body: JSON.stringify({
                  execution: {
                    ...execution,
                    capabilityRoots,
                    agent: {
                      ...execution.agent,
                      instructions: [execution.agent.instructions, portableInstructions]
                        .filter(Boolean)
                        .join("\n\n"),
                      tools: [
                        ...(execution.agent.tools ?? []).filter((tool) => tool.type !== "mcp"),
                        ...(assigned.mcp ?? []),
                      ].map((tool) =>
                        tool.type === "mcp" &&
                        (harness !== "codex" ||
                          (tool.transport.type === "http" &&
                            tool.connection_origin !== "environment"))
                          ? {
                              ...tool,
                              transport: {
                                type: "http",
                                server_url: `http://mcp.internal/${tool.server_label}`,
                              },
                              connection_origin: "service",
                              credential_id: null,
                              request_metadata: {},
                            }
                          : tool,
                      ),
                    },
                  },
                  operationId,
                  checkpoint,
                }),
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
          return yield* new ApiError(409, "stale_generation", "Execution was superseded");
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
      this.lifecycle.withPermits(1)(this.workspace.withPermits(1)(this.snapshot(execution))),
    );
  }
  private snapshot(execution: Execution) {
    return Effect.gen(this, function* () {
      const current = yield* assignment;
      if (superseded(current, execution))
        return yield* new ApiError(409, "stale_generation", "Execution was superseded");
      if (current.parent)
        return yield* new ApiError(
          409,
          "invalid_checkpoint",
          "Delegated children are not checkpointed",
        );
      const key = `sessions/${execution.sessionId}/${execution.generation}/native.json`;
      const committed = yield* read((tx) => tx.checkpoint(execution.generation));
      if (committed) return committed;
      const response = yield* io("snapshot", (signal) =>
        this.containerFetch(`http://harness/jobs/${execution.turnId}/checkpoint`, { signal }),
      );
      if (!response.ok || !response.body)
        return yield* new TransportFailure({
          operation: "snapshot",
          cause: `Native checkpoint failed (${response.status})`,
        });
      // containerFetch may return a chunked stream; R2 requires a known length.
      const bytes = yield* io("snapshot", () => response.arrayBuffer());
      // The checkpoint record below names this object: its outcome must be observed.
      yield* Effect.uninterruptible(io("snapshot", () => this.env.CHECKPOINTS.put(key, bytes)));
      const sandbox = getSandbox(this.env.SANDBOX, execution.sessionId);
      const workspace = execution.sandbox
        ? yield* io("snapshot", () =>
            sandbox.createBackup({
              dir: "/workspace",
              localBucket: this.env.LOCAL_BACKUPS === "true",
              ttl: 30 * 24 * 60 * 60,
            }),
          )
        : undefined;
      // The live filesystem now equals the committed workspace; the next turn may continue in it.
      if (workspace)
        yield* this.rememberSandbox(sandbox, { workspaceId: workspace.id, provisioned: true }).pipe(
          Effect.catchAll(() => write((tx) => tx.forgetSandbox())),
        );
      const artifacts =
        execution.sandbox && execution.environmentId ? yield* publishArtifacts(execution) : [];
      const checkpoint: Checkpoint = {
        version: 1,
        driver: current.harness,
        revision: HARNESSES[current.harness].revision,
        native: key,
        ...(workspace ? { workspace } : {}),
        artifacts,
        environmentFileVersion: this.environment.fileVersion(),
      };
      yield* write((tx) => tx.putCheckpoint(execution.generation, checkpoint));
      return checkpoint;
    });
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
          if (lines?.length)
            console.warn("Native harness diagnostics", {
              sessionId: execution.sessionId,
              turnId: execution.turnId,
              lines: lines.slice(-50),
            });
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
/** Image-bearing parts of a command, for the digest allow-list. */
function commandParts(command: RuntimeCommand): readonly { type: string; image_url?: string }[] {
  if (command.type === "steer") return command.input.flatMap((message) => message.content);
  if (command.type === "tool_result" && Array.isArray(command.output)) return command.output;
  return [];
}
function rejectionMessage(
  body: { code?: unknown; message?: unknown; error?: unknown },
  status: number,
): string {
  if (typeof body.message === "string") return body.message;
  if (typeof body.error === "string") return body.error;
  return `Harness rejected control (${status})`;
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
HarnessContainer.outboundByHost = {
  "media.internal": async (request: Request, bindings: unknown, ctx: { containerId: string }) => {
    const env = bindings as ContainerBindings;
    return env.HARNESS.get(env.HARNESS.idFromString(ctx.containerId)).mediaRequest(request);
  },
  "programmatic.internal": async (
    request: Request,
    bindings: unknown,
    ctx: { containerId: string },
  ) => {
    const env = bindings as ContainerBindings;
    return env.HARNESS.get(env.HARNESS.idFromString(ctx.containerId)).programmaticRequest(request);
  },
  "mcp.internal": async (request: Request, bindings: unknown, ctx: { containerId: string }) => {
    const env = bindings as ContainerBindings;
    return env.HARNESS.get(env.HARNESS.idFromString(ctx.containerId)).mcpRequest(request);
  },
  "delegate.internal": async (
    request: Request,
    bindings: unknown,
    ctx: { containerId: string },
  ) => {
    const env = bindings as ContainerBindings;
    return env.HARNESS.get(env.HARNESS.idFromString(ctx.containerId)).delegateRequest(request);
  },
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
