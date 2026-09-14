import { Container } from "@cloudflare/containers";
import { getSandbox, type ISandbox, Sandbox } from "@cloudflare/sandbox";
import { Effect, Schema } from "effect";
import { z } from "zod";
import type { McpToolConfig } from "./agent-tools.js";
import type { CatalogObject } from "./catalog.js";
import { EnvironmentWorkspace, type ExportedEnvironment } from "./container-environments.js";
import { attempt, decode, io, runPromise } from "./effect.js";
import type { HostedConfiguration } from "./environment-config.js";
import { environmentMcpScript } from "./environment-mcp.js";
import type { EnvironmentDriver } from "./environments.js";
import { copyKnownLength } from "./files.js";
import { HARNESSES, type HarnessName } from "./harnesses.js";
import { proxyMcp } from "./mcp.js";
import { fetchAssignedImage } from "./media.js";
import { readModelBody } from "./models/body.js";
import { constrainCodexSearch } from "./models/codex-search.js";
import { discoverCapabilities } from "./portable-capabilities.js";
import { runProgrammatic } from "./programmatic.js";
import { programmaticInputSchema } from "./programmatic-contract.js";
import { ApiError } from "./protocol.js";
import type {
  Checkpoint,
  Execution,
  RuntimeBatch,
  RuntimeCommand,
  RuntimeDriver,
} from "./runtime.js";
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
interface Assignment {
  sessionId: string;
  generation: number;
  turnId: string;
  model: string;
  webSearchMode?: "disabled" | "cached" | "live";
  harness: HarnessName;
  dispatched: boolean;
  revoked?: boolean;
  sandbox: boolean;
  tenant?: string;
  vaultIds?: readonly string[];
  mcp?: McpToolConfig[];
  /** Worker-authoritative code tool names; MCP tools are admitted by configured server label. */
  programmatic?: { tools: string[]; deadline: number };
  /** SHA-256 digests of image URLs this execution may fetch; the URLs themselves stay in SQLite items. */
  imageDigests?: string[];
  /** Present when this turn may delegate: the parent configuration children inherit. */
  delegation?: {
    delegates: NonNullable<Execution["delegates"]>;
    maxConcurrentSubagents: number;
    agent: Execution["agent"];
    deadline: number;
    environmentId?: string;
  };
  children?: string[];
  /** Set on a delegated child: it shares the parent's sandbox and is never checkpointed. */
  parent?: { turnId: string; subagentId: string };
}
/** Durable child bookkeeping in the parent HarnessDO; the terminal batch survives child destruction. */
interface ChildRecord {
  execution: Execution;
  terminal?: RuntimeBatch;
}
/**
 * What the live Sandbox filesystem holds. A turn reuses the running sandbox when this
 * matches the workspace it must start from; otherwise it destroys and restores. The same
 * identity is written inside the container so a replaced container cannot be mistaken
 * for the one that was provisioned.
 */
interface SandboxState {
  /** Backup id restored into or committed from the live filesystem; "" for a fresh workspace. */
  workspaceId: string;
  /** The deployment provisioning hook already ran for this workspace. */
  provisioned: boolean;
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
    ctx.blockConcurrencyWhile(async () => {
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
  private readonly environment = new EnvironmentWorkspace(
    this.ctx.storage,
    this.env,
    (sessionId, environmentId) =>
      io("environment.export", () =>
        this.env.HARNESS.getByName(sessionId).exportEnvironment(environmentId),
      ),
  );
  private readonly codeExecutions = new Set<AbortController>();
  async mediaRequest(request: Request): Promise<Response> {
    const assignment = await runPromise(this.assignment());
    const url = new URL(request.url);
    const source = url.searchParams.get("url");
    if (
      request.method !== "GET" ||
      url.pathname !== "/image" ||
      assignment.revoked ||
      !source ||
      !assignment.imageDigests?.includes(await sha256Hex(source))
    )
      return new Response("Image is not assigned to this execution", { status: 403 });
    return fetchAssignedImage(source, request.signal);
  }
  /** The bounded set of remote image URLs a turn may fetch, as digests; excess is an explicit error. */
  private imageDigests(urls: readonly string[], existing: readonly string[]) {
    return Effect.gen(function* () {
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
  }
  /** Code may call client functions, workspace tools and tools of configured MCP servers only. */
  private permittedCodeTool(assignment: Assignment, name: string): boolean {
    if (!assignment.programmatic) return false;
    if (assignment.programmatic.tools.includes(name)) return true;
    return (assignment.mcp ?? []).some((tool) => name.startsWith(`mcp__${tool.server_label}__`));
  }
  async programmaticRequest(request: Request): Promise<Response> {
    const assignment = await runPromise(this.assignment());
    if (
      request.method !== "POST" ||
      new URL(request.url).pathname !== `/${assignment.turnId}` ||
      !assignment.programmatic ||
      assignment.revoked ||
      !this.env.CODE_LOADER
    )
      return new Response("No code runner assigned", { status: 403 });
    const controller = new AbortController();
    this.codeExecutions.add(controller);
    try {
      const input = programmaticInputSchema.parse(await request.json());
      const invocation = z.string().uuid().parse(request.headers.get("x-cf-code-invocation"));
      const catalog = await this.containerFetch(
        `http://harness/jobs/${assignment.turnId}/code-tools?invocation=${invocation}`,
      );
      if (!catalog.ok) throw new Error("Code tool catalog is unavailable");
      // The container proposes names; the Worker's assignment decides what code may call.
      const tools = z
        .array(z.string().min(1).max(256))
        .max(2000)
        .parse(await catalog.json())
        .filter((name) => this.permittedCodeTool(assignment, name));
      const value = await runProgrammatic(this.env.CODE_LOADER, {
        input,
        tools,
        signal: controller.signal,
        timeoutMs: assignment.programmatic.deadline - Date.now(),
        call: async (name, args, signal) => {
          const current = await runPromise(this.assignment());
          if (
            current.revoked ||
            current.turnId !== assignment.turnId ||
            current.generation !== assignment.generation
          )
            throw new Error("Execution was superseded");
          if (!this.permittedCodeTool(current, name)) throw new Error("Tool is not allowed");
          const result = await this.containerFetch(
            new Request(`http://harness/jobs/${assignment.turnId}/code-tool`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ name, arguments: args, invocation }),
              signal,
            }),
          );
          if (!result.ok) throw new Error("Programmatic tool call failed");
          return result.json();
        },
      });
      return Response.json({
        content: [{ type: "text", text: JSON.stringify(value) }],
        isError: false,
      });
    } catch (error) {
      const terminal =
        error instanceof ApiError && error.code === "programmatic_execution_uncertain";
      if (terminal) {
        const current = await runPromise(this.assignment());
        if (current.turnId === assignment.turnId && current.generation === assignment.generation) {
          this.db.put("assignment", "current", { ...current, revoked: true } satisfies Assignment);
          // A child reports the uncertain outcome; its parent's failure destroys the shared sandbox.
          if (assignment.sandbox && !assignment.parent) {
            this.forgetSandbox();
            await getSandbox(this.env.SANDBOX, assignment.sessionId).destroy();
          }
        }
      }
      return Response.json({
        content: [
          {
            type: "text",
            text: error instanceof ApiError ? error.message : "Code execution failed",
          },
        ],
        isError: true,
        terminal,
      });
    } finally {
      controller.abort();
      this.codeExecutions.delete(controller);
    }
  }
  prepareEnvironment(...args: Parameters<EnvironmentDriver["prepare"]>) {
    const [spec] = args;
    return runPromise(
      this.workspace.withPermits(1)(
        this.environment.prepare(...args).pipe(
          // Setup left the live sandbox holding exactly the committed base (plus whatever
          // setup commands wrote outside /workspace); the first turn can continue in it.
          Effect.zipRight(
            Effect.suspend(() =>
              this.sandboxState() || !this.environment.base()
                ? Effect.void
                : this.rememberSandbox(getSandbox(this.env.SANDBOX, spec.sessionId), {
                    workspaceId: this.environment.base()?.id ?? "",
                    provisioned: this.environment.inherited(),
                  }),
            ),
          ),
        ),
      ),
    );
  }
  private sandboxState(): SandboxState | undefined {
    return this.db.get<SandboxState>("sandbox", "current");
  }
  private forgetSandbox(): void {
    this.db.remove("sandbox", "current");
  }
  /** Record the workspace the live filesystem holds, inside the container and durably. */
  private rememberSandbox(sandbox: ISandbox, state: SandboxState) {
    return Effect.gen(this, function* () {
      const written = yield* io("sandbox.marker", () =>
        sandbox.writeFile(SANDBOX_MARKER, JSON.stringify({ workspaceId: state.workspaceId })),
      );
      if (!written.success) return yield* Effect.fail(new Error("Sandbox marker write failed"));
      yield* attempt("sandbox.remember", () => this.db.put("sandbox", "current", state));
    });
  }
  /** True when the running sandbox provably holds `workspaceId`; any doubt means restore. */
  private sandboxHolds(sandbox: ISandbox, sessionId: string, workspaceId: string) {
    return Effect.gen(this, function* () {
      const state = this.sandboxState();
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
    return runPromise(this.environment.status(...args));
  }
  async exportEnvironment(environmentId: string): Promise<ExportedEnvironment> {
    return this.environment.exported(environmentId);
  }
  uploadEnvironmentFile(...args: Parameters<EnvironmentDriver["upload"]>) {
    return runPromise(this.workspace.withPermits(1)(this.environment.upload(...args)));
  }
  environmentFiles(...args: Parameters<EnvironmentDriver["files"]>) {
    return runPromise(this.workspace.withPermits(1)(this.environment.files(...args)));
  }
  protected async prepareSandbox(_sandbox: ISandbox, _execution: Execution): Promise<void> {}
  private assignment() {
    return attempt("assignment", () => {
      const assignment = this.db.get<Assignment>("assignment", "current");
      if (!assignment)
        throw new ApiError(409, "unassigned_container", "Container has no session assignment");
      return assignment;
    });
  }
  mcpRequest(request: Request): Promise<Response> {
    return runPromise(
      Effect.gen(this, function* () {
        const assignment = yield* this.assignment();
        if (assignment.revoked)
          return new Response("Execution authority was revoked", { status: 409 });
        const tool = assignment.mcp?.find(
          (tool) => `/${tool.server_label}` === new URL(request.url).pathname,
        );
        if (!tool) return new Response(null, { status: 404 });
        if (tool.transport.type === "stdio" || tool.connection_origin === "environment") {
          if (!assignment.sandbox || assignment.harness === "codex")
            return new Response(null, { status: 404 });
          const url = new URL(request.url);
          url.hostname = "environment-mcp.internal";
          return yield* io("mcp.environment", () =>
            this.env.SANDBOX.getByName(assignment.sessionId).fetch(new Request(url, request)),
          );
        }
        const serverURL = tool.transport.server_url;
        const tenant = assignment.tenant;
        const token = tenant
          ? yield* io("mcp.credential", () =>
              this.env.CATALOG.getByName(tenant).mcpToken(
                [...(assignment.vaultIds ?? [])],
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
          sender ? (request) => sender.fetch(request) : fetch,
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
  async delegateRequest(request: Request): Promise<Response> {
    const assignment = await runPromise(this.assignment());
    const url = new URL(request.url);
    const [turnId, target, action] = url.pathname.split("/").slice(1);
    const delegation = assignment.delegation;
    if (assignment.revoked || turnId !== assignment.turnId || !delegation)
      return new Response("Delegation is not available for this execution", { status: 403 });
    if (request.method === "POST" && target === "spawn" && !action)
      return this.spawnChild(assignment, delegation, await request.json());
    if (!target) return new Response(null, { status: 404 });
    const child = this.db.get<ChildRecord>("child", target);
    if (!child || child.execution.parent?.turnId !== turnId)
      return new Response("Unknown subagent", { status: 404 });
    if (request.method === "GET" && !action) {
      if (child.terminal) return Response.json(child.terminal);
      const after = z.coerce
        .number()
        .int()
        .min(0)
        .parse(url.searchParams.get("after") ?? "0");
      const batch = decode(
        batchSchema,
        await (await this.child(target).pollExecution(child.execution, after)).json(),
      );
      if (batch.status !== "running" && batch.status !== "waiting") {
        // Durable before the child Container disappears, so a lost response can be retried.
        this.db.put("child", target, { ...child, terminal: batch } satisfies ChildRecord);
        await this.child(target)
          .stopExecution(child.execution)
          .catch((error) => console.warn("Delegated child stop failed", { error: String(error) }));
      }
      return Response.json(batch);
    }
    if (request.method === "POST" && action === "control") {
      if (child.terminal) return new Response("Subagent has stopped", { status: 409 });
      const body = decode(
        Schema.Struct({ operationId: Schema.String, command: commandSchema }),
        await request.json(),
      );
      await this.child(target).controlExecution(child.execution, body.operationId, body.command);
      return new Response(null, { status: 204 });
    }
    return new Response(null, { status: 404 });
  }
  private async spawnChild(
    assignment: Assignment,
    delegation: NonNullable<Assignment["delegation"]>,
    input: unknown,
  ): Promise<Response> {
    const parsed = spawnRequestSchema.safeParse(input);
    if (!parsed.success) return new Response("Invalid spawn request", { status: 400 });
    const delegate = delegation.delegates.find((entry) => entry.alias === parsed.data.alias);
    if (!delegate) return new Response("Unknown delegate", { status: 404 });
    const children = assignment.children ?? [];
    const active = children.filter((id) => !this.db.get<ChildRecord>("child", id)?.terminal).length;
    if (active >= delegation.maxConcurrentSubagents)
      return new Response("Concurrent subagent limit reached", { status: 409 });
    const subagentId = `subagent_${crypto.randomUUID().replaceAll("-", "")}`;
    const turnId = `turn_${crypto.randomUUID().replaceAll("-", "")}`;
    const execution: Execution = {
      sessionId: assignment.sessionId,
      turnId,
      generation: assignment.generation,
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
      sandbox: assignment.sandbox,
      ...(delegation.environmentId ? { environmentId: delegation.environmentId } : {}),
      capabilityRoots: this.environment.capabilityRoots(),
      ...(assignment.tenant ? { tenant: assignment.tenant } : {}),
      ...(assignment.vaultIds ? { vaultIds: [...assignment.vaultIds] } : {}),
      parent: { turnId: assignment.turnId, subagentId },
    };
    this.db.transaction(() => {
      this.db.put("child", subagentId, { execution } satisfies ChildRecord);
      this.db.put("assignment", "current", {
        ...assignment,
        children: [...children, subagentId],
      } satisfies Assignment);
    });
    try {
      await this.child(subagentId).startExecution(execution, `${turnId}:start`);
    } catch (error) {
      console.warn("Delegated child start failed", { subagentId, error: String(error) });
      this.db.put("child", subagentId, {
        execution,
        terminal: { status: "failed", events: [], cursor: 0, error: "subagent_start_failed" },
      } satisfies ChildRecord);
      await this.child(subagentId)
        .stopExecution(execution)
        .catch(() => {});
      return new Response("Subagent could not be started", { status: 502 });
    }
    return Response.json({ subagentId, turnId });
  }
  override async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).hostname === "sandbox.internal") return this.sandboxRequest(request);
    return super.fetch(request);
  }
  private async sandboxRequest(request: Request): Promise<Response> {
    const assignment = await runPromise(this.assignment());
    if (assignment.revoked) return new Response("Execution authority was revoked", { status: 409 });
    if (!assignment.sandbox) return new Response("No sandbox assigned", { status: 403 });
    if (new URL(request.url).pathname === "/tools" && request.method === "POST") {
      const input = await request.json();
      const abort = new AbortController();
      let onOutput: ((text: string) => void) | undefined;
      const operation = () =>
        runPromise(
          this.workspace.withPermits(1)(
            io("workspace.tool", async () => {
              const current = await runPromise(this.assignment());
              if (
                current.revoked ||
                current.turnId !== assignment.turnId ||
                current.generation !== assignment.generation
              )
                throw new ApiError(409, "stale_generation", "Execution was superseded");
              abort.signal.throwIfAborted();
              return executeWorkspaceTool(
                getSandbox(this.env.SANDBOX, assignment.sessionId),
                input,
                onOutput ? { onOutput, signal: abort.signal } : undefined,
              );
            }),
          ),
        );
      if (request.headers.get("accept") === "application/x-ndjson") {
        const encoder = new TextEncoder();
        return new Response(
          new ReadableStream({
            start(controller) {
              const send = (value: unknown) => {
                if (!abort.signal.aborted)
                  controller.enqueue(encoder.encode(`${JSON.stringify(value)}\n`));
              };
              onOutput = (text) => send({ type: "delta", text });
              void operation()
                .then(
                  (result) => send({ type: "result", ...result }),
                  () => send({ type: "error", message: "Workspace operation failed" }),
                )
                .finally(() => {
                  // The consumer may already have closed the stream without cancelling it.
                  try {
                    if (!abort.signal.aborted) controller.close();
                  } catch {
                    abort.abort();
                  }
                });
            },
            cancel() {
              abort.abort();
            },
          }),
          { headers: { "content-type": "application/x-ndjson" } },
        );
      }
      try {
        return Response.json(await operation());
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
        if (assignment.revoked)
          return new Response("Execution authority was revoked", { status: 409 });
        const url = new URL(request.url);
        if (request.method !== "POST" || url.pathname !== HARNESSES[assignment.harness].protocol)
          return new Response("Unsupported model request", { status: 403 });
        const bytes = yield* io("modelRequest", () => readModelBody(request));
        const body = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
        if (!body || body.model !== assignment.model)
          return new Response("Model is not assigned to this execution", { status: 403 });
        const current = yield* this.assignment();
        if (current.turnId !== assignment.turnId || current.generation !== assignment.generation)
          return new Response("Execution was superseded", { status: 409 });
        return yield* io("modelRequest", () =>
          this.env.MODEL_GATEWAY.fetch(
            new Request(request, {
              body:
                assignment.harness === "codex" && assignment.webSearchMode !== undefined
                  ? JSON.stringify(constrainCodexSearch(body, assignment.webSearchMode))
                  : bytes,
            }),
          ),
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
      const previous = yield* attempt("startAttempt", () =>
        this.db.get<Assignment>("assignment", "current"),
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
        imageDigests: yield* this.imageDigests(
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
      for (const controller of this.codeExecutions) controller.abort();
      yield* attempt("startAttempt", () => this.db.put("assignment", "current", assignment));
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
          yield* attempt("startAttempt.forget", () => this.forgetSandbox());
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
        if (!this.sandboxState()?.provisioned) {
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
        const configured = assignment.mcp ?? [];
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
        assignment.mcp = [...configured, ...discovered.mcp];
        const environmentServers = assignment.mcp.filter(
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
          return yield* Effect.fail(
            new ApiError(409, "checkpoint_missing", "Native checkpoint is missing"),
          );
        checkpoint = yield* io("startAttempt", () => object.json());
      }
      yield* io("startAttempt", () => this.startAndWaitForPorts());
      // Durable dispatch tombstone: retries may inspect, but cannot replay a lost job.
      yield* attempt("startAttempt", () =>
        this.db.put("assignment", "current", { ...assignment, dispatched: true }),
      );
      const result = yield* io("startAttempt", () =>
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
                  ...(assignment.mcp ?? []),
                ].map((tool) =>
                  tool.type === "mcp" &&
                  (harness !== "codex" ||
                    (tool.transport.type === "http" && tool.connection_origin !== "environment"))
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
        const parts =
          command.type === "steer"
            ? command.input.flatMap((message) => message.content)
            : command.type === "tool_result" && Array.isArray(command.output)
              ? command.output
              : [];
        const allowedImages = remoteImageURLs(parts);
        if (allowedImages.length) {
          const imageDigests = yield* this.imageDigests(
            allowedImages,
            assignment.imageDigests ?? [],
          );
          yield* attempt("controlExecution.images", () =>
            this.db.put("assignment", "current", { ...assignment, imageDigests }),
          );
        }
        const result = yield* io("controlExecution", () =>
          this.containerFetch(`http://harness/jobs/${execution.turnId}/control`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ operationId, command }),
          }),
        );
        if (command.type === "cancel")
          for (const controller of this.codeExecutions) controller.abort();
        if (!result.ok) {
          // A definite rejection is an API error the session can act on; anything else is retried.
          const body = yield* io(
            "controlExecution.body",
            (): Promise<{ code?: unknown; message?: unknown; error?: unknown }> =>
              result
                .json<{ code?: unknown; message?: unknown; error?: unknown }>()
                .catch(() => ({})),
          );
          const message =
            typeof body.message === "string"
              ? body.message
              : typeof body.error === "string"
                ? body.error
                : `Harness rejected control (${result.status})`;
          if (result.status === 409) return yield* new ApiError(409, "command_rejected", message);
          if (result.status === 404) return yield* new ApiError(404, "execution_missing", message);
          return yield* Effect.fail(new Error(message));
        }
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
      if (assignment.parent)
        return yield* Effect.fail(
          new ApiError(409, "invalid_checkpoint", "Delegated children are not checkpointed"),
        );
      const key = `sessions/${execution.sessionId}/${execution.generation}/native.json`;
      const committed = yield* attempt("snapshot", () =>
        this.db.get<Checkpoint>("checkpoint", String(execution.generation)),
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
          Effect.catchAll(() => attempt("snapshot.forget", () => this.forgetSandbox())),
        );
      const artifacts =
        execution.sandbox && execution.environmentId ? yield* this.publishArtifacts(execution) : [];
      const checkpoint: Checkpoint = {
        version: 1,
        driver: assignment.harness,
        revision: HARNESSES[assignment.harness].revision,
        native: key,
        ...(workspace ? { workspace } : {}),
        artifacts,
        environmentFileVersion: this.environment.fileVersion(),
      };
      yield* attempt("snapshot", () =>
        this.db.put("checkpoint", String(execution.generation), checkpoint),
      );
      return checkpoint;
    });
  }
  private publishArtifacts(execution: Execution) {
    return Effect.gen(this, function* () {
      const sandbox = getSandbox(this.env.SANDBOX, execution.sessionId);
      if (!(yield* io("artifact.exists", () => sandbox.exists("/workspace/outputs"))).exists)
        return [];
      const manifestKey = String(execution.generation);
      let manifest = yield* attempt("artifact.manifest.get", () =>
        this.db.get<NonNullable<Checkpoint["artifacts"]>>("artifacts", manifestKey),
      );
      if (!manifest) {
        const listing = yield* io("artifact.list", () =>
          sandbox.listFiles("/workspace/outputs", { recursive: true, includeHidden: true }),
        );
        if (!listing.success)
          return yield* new ApiError(503, "artifact_list_failed", "Artifact listing failed");
        const files = listing.files.filter((file) => file.type === "file");
        if (
          files.some((file) => file.size > 200 * 1024 * 1024) ||
          files.reduce((sum, file) => sum + file.size, 0) > 500 * 1024 * 1024
        )
          return yield* new ApiError(
            413,
            "artifact_limit",
            "Artifacts exceed 200 MiB per file or 500 MiB per turn",
          );
        manifest = yield* Effect.forEach(files, (file) =>
          Effect.gen(function* () {
            const hash = yield* io("artifact.hash", () =>
              crypto.subtle.digest(
                "SHA-256",
                new TextEncoder().encode(`${execution.turnId}\0${file.absolutePath}`),
              ),
            );
            const id = `artifact_${Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
            return {
              id,
              key: `artifacts/${execution.sessionId}/${id}`,
              path: file.absolutePath,
              size_bytes: file.size,
              session_id: execution.sessionId,
              environment_id: execution.environmentId ?? "",
              turn_id: execution.turnId,
              created_at: Math.floor(Date.now() / 1000),
            };
          }),
        );
        yield* attempt("artifact.manifest.commit", () =>
          this.db.put("artifacts", manifestKey, manifest),
        );
      }
      yield* Effect.forEach(
        manifest,
        (artifact) =>
          Effect.gen(this, function* () {
            if (yield* io("artifact.head", () => this.env.CHECKPOINTS.head(artifact.key))) return;
            const source = yield* io("artifact.read", () =>
              sandbox.readFile(artifact.path, { encoding: "none" }),
            );
            yield* copyKnownLength(source.content, artifact.size_bytes, (stream) =>
              this.env.CHECKPOINTS.put(artifact.key, stream, {
                httpMetadata: { contentType: "application/octet-stream" },
              }),
            );
          }),
        { discard: true },
      );
      return manifest;
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
      for (const controller of this.codeExecutions) controller.abort();
      yield* attempt("stopAttempt.revoke", () =>
        this.db.put("assignment", "current", { ...assignment, revoked: true }),
      );
      // Native stderr is lost with the Container; keep a bounded tail in Worker logs.
      if (assignment.dispatched)
        yield* io("stopAttempt.diagnostics", async () => {
          const response = await this.containerFetch("http://harness/diagnostics", {
            signal: AbortSignal.timeout(5_000),
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
      for (const subagentId of assignment.children ?? []) {
        const child = this.db.get<ChildRecord>("child", subagentId);
        if (child && !child.terminal)
          yield* io("stopAttempt.child", () =>
            this.child(subagentId).stopExecution(child.execution),
          ).pipe(Effect.ignore);
      }
      yield* io("stopAttempt", () => this.destroy());
      if (assignment.sandbox && !assignment.parent) {
        // Uncommitted workspace state is discarded; the next turn restores the last checkpoint.
        yield* attempt("stopAttempt.forget", () => this.forgetSandbox());
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
      subagents: harness === "codex",
      images: true,
      reasoningSummaries: true,
      usage: true,
      webSearch: harness === "codex",
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
