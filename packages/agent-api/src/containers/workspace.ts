import { Effect } from "effect";

import type { McpToolConfig } from "../agent-tools.js";
import { attempt, io } from "../effect.js";
import { environmentMcpScript } from "../environment-mcp.js";
import type { SandboxState } from "../persistence/harness-kinds.js";
import { discoverCapabilities } from "../portable-capabilities.js";
import type { Checkpoint, Execution } from "../runtime.js";
import type { ExecResult, ListedFile } from "./exec.js";
import { type ContainerBindings, HarnessBindings, type HarnessHost, read, write } from "./host.js";
import type { SandboxExecOptions } from "./sandbox.js";

/**
 * A session's sandbox as deployment code and the harness use it: commands and files under
 * `/workspace`. Each call reaches the session's SandboxDO, which starts the container on
 * first use. Paths are absolute; `writeFile` creates parent directories.
 */
export interface Workspace {
  exec(argv: string[], options?: SandboxExecOptions): Promise<ExecResult>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string | Uint8Array): Promise<void>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  remove(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  list(directory: string): Promise<ListedFile[]>;
}

export const sandboxOf = (env: ContainerBindings, sessionId: string) =>
  env.SANDBOX.getByName(sessionId);

/** The `Workspace` of a session, over its SandboxDO. */
export function workspaceOf(env: ContainerBindings, sessionId: string): Workspace {
  const sandbox = () => sandboxOf(env, sessionId);
  return {
    exec: async (argv, options) => ({ ...(await sandbox().exec(argv, options)) }),
    readFile: (path) => sandbox().readFile(path),
    writeFile: (path, content) => sandbox().writeFile(path, content),
    mkdir: (path) => sandbox().mkdir(path),
    remove: (path) => sandbox().remove(path),
    exists: (path) => sandbox().exists(path),
    list: async (directory) => (await sandbox().list(directory)).map((file) => ({ ...file })),
  };
}

const SANDBOX_MARKER = "/tmp/cf-open-agents-sandbox.json";

/** Record the workspace the live filesystem holds, inside the container and durably. */
export function rememberSandbox(workspace: Workspace, state: SandboxState) {
  return Effect.gen(function* () {
    yield* io("sandbox.marker", () =>
      workspace.writeFile(SANDBOX_MARKER, JSON.stringify({ workspaceId: state.workspaceId })),
    );
    yield* write((tx) => tx.rememberSandbox(state));
  });
}
/** True when the running sandbox provably holds `workspaceId`; any doubt means restore. */
function sandboxHolds(sessionId: string, workspace: Workspace, workspaceId: string) {
  return Effect.gen(function* () {
    const env = yield* HarnessBindings;
    const state = yield* read((tx) => tx.sandbox());
    if (!state || state.workspaceId !== workspaceId) return false;
    // A container the platform replaced, or one the lease ended, holds nothing.
    const running = yield* io("sandbox.status", () => sandboxOf(env, sessionId).running()).pipe(
      Effect.orElseSucceed(() => false),
    );
    if (!running) return false;
    const marker = yield* io("sandbox.marker.read", () => workspace.readFile(SANDBOX_MARKER)).pipe(
      Effect.option,
    );
    if (marker._tag === "None") return false;
    return yield* attempt("sandbox.marker.decode", () => {
      const parsed: unknown = JSON.parse(marker.value);
      return (
        typeof parsed === "object" &&
        parsed !== null &&
        "workspaceId" in parsed &&
        parsed.workspaceId === workspaceId
      );
    }).pipe(Effect.orElseSucceed(() => false));
  });
}
/**
 * A running sandbox that provably holds the committed workspace continues as is,
 * including state outside /workspace. Anything else starts from the last committed
 * filesystem checkpoint: a fresh container, the stored configuration, then the restore.
 * The deployment hook then runs once per fresh workspace; an inherited workspace was
 * provisioned. Uploads made since the checkpoint are applied last.
 */
export function prepareWorkspace(
  host: HarnessHost,
  execution: Execution,
  previousWorkspace: NonNullable<Checkpoint["workspace"]> | undefined,
) {
  return Effect.gen(function* () {
    const env = yield* HarnessBindings;
    const workspace = workspaceOf(env, execution.sessionId);
    const sandbox = sandboxOf(env, execution.sessionId);
    const previousCheckpoint = execution.checkpoint;
    const workspaceId = previousWorkspace?.id ?? "";
    const reused = yield* sandboxHolds(execution.sessionId, workspace, workspaceId);
    if (!reused) {
      yield* write((tx) => tx.forgetSandbox());
      yield* io("startAttempt", () => sandbox.stop("restore"));
      const environmentSpec = host.environment.spec();
      // Network policy and variables are part of the container's start.
      if (environmentSpec) yield* host.environment.configure(environmentSpec);
      if (previousWorkspace) yield* io("startAttempt", () => sandbox.restore(previousWorkspace));
      else yield* io("startAttempt", () => workspace.mkdir("/workspace"));
      if (environmentSpec) yield* host.environment.installPackages(environmentSpec);
      yield* rememberSandbox(workspace, {
        workspaceId,
        provisioned: previousCheckpoint !== null || host.environment.inherited(),
      });
    }
    if (!(yield* read((tx) => tx.sandbox()))?.provisioned) {
      yield* io("startAttempt", () => host.prepareSandbox(workspace, execution));
      yield* rememberSandbox(workspace, { workspaceId, provisioned: true });
    }
    yield* host.environment.applyUploads(previousCheckpoint?.environmentFileVersion ?? 0);
  });
}
/** Codex runs its `exec-server` inside the sandbox; started once per container. */
export function ensureCodexServer(sessionId: string) {
  return Effect.gen(function* () {
    const env = yield* HarnessBindings;
    yield* io("startAttempt", () =>
      sandboxOf(env, sessionId).serve(
        ["codex", "exec-server", "--listen", "ws://0.0.0.0:4500"],
        4500,
      ),
    );
  });
}
/**
 * Discover workspace capabilities and bridge the environment-origin MCP servers. Plugin-
 * derived labels are sanitized and kept distinct from configured servers, so workspace
 * content can add servers but never replace or break configured ones.
 */
export function attachCapabilities(
  execution: Execution,
  configured: McpToolConfig[],
  capabilityRoots: string[],
) {
  return Effect.gen(function* () {
    const env = yield* HarnessBindings;
    const workspace = workspaceOf(env, execution.sessionId);
    const discovered = yield* io("capabilities.discover", () =>
      discoverCapabilities(workspace, capabilityRoots, {
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
    if (environmentServers.length)
      yield* startEnvironmentBridge(execution.sessionId, workspace, environmentServers);
    return { instructions: discovered.instructions, mcp };
  });
}
/** The in-sandbox bridge that serves stdio and environment-origin MCP servers over HTTP. */
function startEnvironmentBridge(sessionId: string, workspace: Workspace, servers: McpToolConfig[]) {
  return Effect.gen(function* () {
    const env = yield* HarnessBindings;
    yield* io("mcp.bridge.config", () =>
      workspace.writeFile(
        "/tmp/cf-environment-mcp.json",
        JSON.stringify(
          Object.fromEntries(servers.map((tool) => [tool.server_label, tool.transport])),
        ),
      ),
    );
    yield* io("mcp.bridge.script", () =>
      workspace.writeFile("/tmp/cf-environment-mcp.mjs", environmentMcpScript),
    );
    yield* io("mcp.bridge.start", () =>
      sandboxOf(env, sessionId).serve(
        ["node", "/tmp/cf-environment-mcp.mjs", "/tmp/cf-environment-mcp.json"],
        4501,
      ),
    );
  });
}
