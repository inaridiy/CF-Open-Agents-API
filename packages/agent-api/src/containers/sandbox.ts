import { type getSandbox, type ISandbox, Sandbox } from "@cloudflare/sandbox";
import { Effect } from "effect";

import type { McpToolConfig } from "../agent-tools.js";
import { attempt, io } from "../effect.js";
import type { HostedConfiguration } from "../environment-config.js";
import { environmentMcpScript } from "../environment-mcp.js";
import { NetworkPolicyConflict, TransportFailure } from "../errors.js";
import type { SandboxState } from "../persistence/harness-kinds.js";
import { discoverCapabilities } from "../portable-capabilities.js";
import type { Checkpoint, Execution } from "../runtime.js";
import { type ContainerBindings, HarnessBindings, type HarnessHost, read, write } from "./host.js";

const SANDBOX_MARKER = "/tmp/cf-open-agents-sandbox.json";

/** Hosts a sandbox may reach under the environment's network policy. */
function allowedHosts(
  access: NonNullable<HostedConfiguration["network"]>["access"],
  network: HostedConfiguration["network"],
): string[] {
  if (access === "enabled") return ["*"];
  if (access === "restricted") return network?.allowed_domains ?? [];
  return [];
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
      throw new NetworkPolicyConflict();
    await this.ctx.storage.put("environment_internet", enabled);
    this.enableInternet = enabled;
    await this.setAllowedHosts(allowedHosts(access, network));
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
/** The stub `getSandbox` returns: `ISandbox` plus the container lifecycle (destroy, restore). */
export type LiveSandbox = ReturnType<typeof getSandbox<SandboxContainer>>;

/** Record the workspace the live filesystem holds, inside the container and durably. */
export function rememberSandbox(sandbox: ISandbox, state: SandboxState) {
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
export function sandboxHolds(sandbox: ISandbox, sessionId: string, workspaceId: string) {
  return Effect.gen(function* () {
    const env = yield* HarnessBindings;
    const state = yield* read((tx) => tx.sandbox());
    if (!state || state.workspaceId !== workspaceId) return false;
    const runtime = yield* io(
      "sandbox.status",
      async () => await env.SANDBOX.getByName(sessionId).getState(),
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
/** Whether a process inside the sandbox already listens on `port`. */
export function listening(sandbox: ISandbox, port: number) {
  return io("startAttempt.probe", async () => {
    const probe = await sandbox.exec([
      "bash",
      "-c",
      `exec 3<>/dev/tcp/127.0.0.1/${port} 2>/dev/null && echo up || echo down`,
    ]);
    return (await probe.output({ timeout: 10_000, encoding: "utf8" })).stdout.includes("up");
  });
}
/**
 * A running sandbox that provably holds the committed workspace continues as is,
 * including state outside /workspace. Anything else starts from the last committed
 * filesystem checkpoint: destroy, restore, and configure the fresh container. The
 * deployment hook then runs once per fresh workspace; an inherited workspace was
 * provisioned. Uploads made since the checkpoint are applied last.
 */
export function prepareWorkspace(
  host: HarnessHost,
  sandbox: LiveSandbox,
  execution: Execution,
  previousWorkspace: NonNullable<Checkpoint["workspace"]> | undefined,
) {
  return Effect.gen(function* () {
    const previousCheckpoint = execution.checkpoint;
    const workspaceId = previousWorkspace?.id ?? "";
    const reused = yield* sandboxHolds(sandbox, execution.sessionId, workspaceId);
    if (!reused) {
      yield* write((tx) => tx.forgetSandbox());
      yield* io("startAttempt", () => sandbox.destroy());
      if (previousWorkspace)
        yield* io("startAttempt", () => sandbox.restoreBackup(previousWorkspace));
      else {
        yield* io("startAttempt", () => sandbox.mkdir("/workspace", { recursive: true }));
      }
      const environmentSpec = host.environment.spec();
      if (environmentSpec) yield* host.environment.configure(environmentSpec);
      yield* rememberSandbox(sandbox, {
        workspaceId,
        provisioned: previousCheckpoint !== null || host.environment.inherited(),
      });
    }
    if (!(yield* read((tx) => tx.sandbox()))?.provisioned) {
      yield* io("startAttempt", () => host.prepareSandbox(sandbox, execution));
      yield* rememberSandbox(sandbox, { workspaceId, provisioned: true });
    }
    yield* host.environment.applyUploads(previousCheckpoint?.environmentFileVersion ?? 0);
  });
}
/** Codex runs its app server inside the sandbox; start it once per container. */
export function ensureCodexServer(sandbox: ISandbox) {
  return Effect.gen(function* () {
    if (yield* listening(sandbox, 4500)) return;
    const executor = yield* io("startAttempt", () =>
      sandbox.exec(["codex", "exec-server", "--listen", "ws://0.0.0.0:4500"]),
    );
    yield* io("startAttempt", () => executor.waitForPort(4500));
  });
}
/**
 * Discover workspace capabilities and bridge the environment-origin MCP servers. Plugin-
 * derived labels are sanitized and kept distinct from configured servers, so workspace
 * content can add servers but never replace or break configured ones.
 */
export function attachCapabilities(
  sandbox: ISandbox,
  execution: Execution,
  configured: McpToolConfig[],
  capabilityRoots: string[],
) {
  return Effect.gen(function* () {
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
    const mcp = [...configured, ...discovered.mcp];
    const environmentServers = mcp.filter(
      (tool) => tool.transport.type === "stdio" || tool.connection_origin === "environment",
    );
    if (environmentServers.length && !(yield* listening(sandbox, 4501)))
      yield* startEnvironmentBridge(sandbox, environmentServers);
    return { instructions: discovered.instructions, mcp };
  });
}
/** The in-sandbox bridge that serves stdio and environment-origin MCP servers over HTTP. */
function startEnvironmentBridge(sandbox: ISandbox, servers: McpToolConfig[]) {
  return Effect.gen(function* () {
    yield* io("mcp.bridge.config", () =>
      sandbox.writeFile(
        "/tmp/cf-environment-mcp.json",
        JSON.stringify(
          Object.fromEntries(servers.map((tool) => [tool.server_label, tool.transport])),
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
  });
}
