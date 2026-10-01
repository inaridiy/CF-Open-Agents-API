import {
  DirectoryBackup,
  type DirectoryBackupGatewayBinding,
  type DirectoryBackupRecord,
} from "@cloudflare/sandbox";
import { DurableObject } from "cloudflare:workers";
import { Effect } from "effect";

import { io, runPromise, type ServiceError } from "../effect.js";
import type { HostedConfiguration } from "../environment-config.js";
import {
  ContainerMisconfigured,
  NetworkPolicyConflict,
  StoredObjectMissing,
  TransportFailure,
} from "../errors.js";
import { executeWorkspaceTool } from "../sandbox-tools.js";
import { type EntrypointLoopback, exported, type SandboxEgressProps } from "./egress.js";
import * as exec from "./exec.js";
import type { ContainerBindings } from "./host.js";
import { makeLease } from "./lease.js";

/** A failure this cleanup cannot act on. */
const ignore = (): void => {};

/** The named image a SandboxDO starts: `containers[].images.sandbox` in Wrangler configuration. */
export const SANDBOX_IMAGE = "sandbox";
export const WORKSPACE = "/workspace";
/** R2 key prefix of 1.0 workspace backups in `BACKUP_BUCKET`. */
const BACKUP_PREFIX = "workspaces/";
const IDLE_MS = 10 * 60 * 1000;
/**
 * A new container that has not taken its intercepts and first command by then will not: the
 * platform can leave a start pending indefinitely, and the boot must fail instead of hanging.
 */
const PREPARE_TIMEOUT_MS = 3 * 60 * 1000;
/** A backup or restore that takes longer has failed; it must not hold the workspace permit. */
const BACKUP_TIMEOUT_MS = 15 * 60 * 1000;
/** Container ports behind the hosts a harness reaches through this object. */
const SANDBOX_PORTS: Readonly<Record<string, number>> = {
  "sandbox.internal": 4500,
  "environment-mcp.internal": 4501,
};
/**
 * The platform's own stop after the object goes inactive: a backstop for an object that
 * stops running alarms. The lease's idle timer decides first.
 */
const INACTIVITY_BACKSTOP_MS = IDLE_MS + 5 * 60 * 1000;
const CA = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";
const BUNDLE = "/etc/ssl/certs/ca-certificates.crt";
const SYSTEM_BUNDLE = "/etc/ssl/certs/ca-certificates.system.crt";
/**
 * The intercepted HTTPS of a restricted sandbox is signed by a certificate the container
 * receives at start. Rebuild the system bundle from its pristine copy plus that
 * certificate, so repeating this for the same container writes the same bundle.
 */
const TRUST = `[ -e ${SYSTEM_BUNDLE} ] || cp ${BUNDLE} ${SYSTEM_BUNDLE}; timeout 10 sh -c 'until [ -s ${CA} ]; do sleep 0.1; done' && cat ${SYSTEM_BUNDLE} ${CA} > ${BUNDLE}.tmp && mv ${BUNDLE}.tmp ${BUNDLE}`;

/** Resource names a predefined or custom size `ctx.container.start()` accepts. */
export type ContainerInstance = NonNullable<ContainerStartupOptions["instance"]>;

/** A 0.x Sandbox SDK backup handle: a SquashFS image under `backups/<id>/` in `BACKUP_BUCKET`. */
export interface LegacyWorkspaceBackup {
  readonly id: string;
  readonly dir: string;
  readonly localBucket?: boolean;
}
/** What a checkpoint or an environment base records about `/workspace`. */
export type WorkspaceBackup = DirectoryBackupRecord | LegacyWorkspaceBackup;
const isLegacy = (backup: WorkspaceBackup): backup is LegacyWorkspaceBackup =>
  !("format" in backup);

/** What `start()` and every command need; stored before anything starts the container. */
interface Settings {
  readonly access: "enabled" | "restricted" | "disabled";
  readonly allowed: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

export interface SandboxExecOptions {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  readonly stdin?: exec.ExecInput;
}

/**
 * One session's sandbox: the container that holds `/workspace`. Every operation on it runs
 * here, in the object that owns the container, so the container's lifecycle is decided in
 * one place: a lease boots it on first use, keeps it while it is used, destroys it after
 * ten idle minutes, and never boots it again once the session is deleted.
 */
export class SandboxContainer<
  Env extends ContainerBindings = ContainerBindings,
> extends DurableObject<Env> {
  /** The size `start()` requests; `defineAgentWorker({ instances })` overrides it. */
  protected instance: ContainerInstance = "standard-1";
  private readonly lease = makeLease({
    storage: this.ctx.storage,
    container: () => this.ctx.container,
    boot: Effect.suspend(() => this.boot()),
    destroy: io("sandbox.destroy", () => this.container().destroy()).pipe(
      Effect.zipRight(Effect.sync(() => (this.prepared = undefined))),
    ),
    idleMs: () => this.idleMs(),
    label: "sandbox",
  });
  /** Set up the running container for this object instance: intercepts, trust, timeout. */
  private prepared: Promise<void> | undefined;
  private backupClient: DirectoryBackup | undefined;
  /** Ports known to listen in the current container; a new container starts empty. */
  private readonly listening = new Set<number>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // The inactivity timeout does not survive a restart of this object; set it again.
    const container = ctx.container;
    if (container?.running)
      void ctx.blockConcurrencyWhile(() =>
        container.setInactivityTimeout(INACTIVITY_BACKSTOP_MS).catch(ignore),
      );
  }
  /** How long the sandbox runs after its last use. */
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
        reason: "SandboxDO has no container: add it to `containers` in the Wrangler configuration",
      });
    return container;
  }
  private settings(): Settings {
    const stored = this.ctx.storage.kv.get<Settings>("settings");
    if (stored) return stored;
    // Written by 0.x: only whether Internet access was enabled.
    const internet = this.ctx.storage.kv.get<boolean>("environment_internet");
    return { access: internet === false ? "disabled" : "enabled", allowed: [], env: {} };
  }
  private backups(): DirectoryBackup {
    this.backupClient ??= new DirectoryBackup(
      this.container(),
      exported<DirectoryBackupGatewayBinding>(this.ctx, "DirectoryBackupGateway"),
      { binding: "BACKUP_BUCKET", prefix: BACKUP_PREFIX },
    );
    return this.backupClient;
  }
  /** Variables every command sees: a login-like environment, the CA bundle, the environment's own. */
  private commandEnv(extra?: Readonly<Record<string, string>>): Record<string, string> {
    const settings = this.settings();
    return {
      HOME: "/root",
      LANG: "C.UTF-8",
      ...(settings.access === "restricted"
        ? { NODE_EXTRA_CA_CERTS: CA, REQUESTS_CA_BUNDLE: BUNDLE, SSL_CERT_FILE: BUNDLE }
        : {}),
      ...settings.env,
      ...extra,
    };
  }

  private boot() {
    return Effect.gen(this, function* () {
      const container = this.container();
      const image = (container.images as Readonly<Record<string, string>> | undefined)?.[
        SANDBOX_IMAGE
      ];
      if (!image)
        return yield* new ContainerMisconfigured({
          reason: `Add an image named "${SANDBOX_IMAGE}" to the SandboxDO container entry (scheduling_policy "durable_object")`,
        });
      if (!container.running) {
        this.prepared = undefined;
        this.listening.clear();
        container.start({
          image,
          instance: this.instance,
          enableInternet: this.settings().access === "enabled",
          env: this.commandEnv(),
        });
      }
      yield* this.prepare();
    });
  }
  /**
   * Intercepts last until the container stops and the inactivity timeout until the object
   * restarts, so both are set for every new container and again by a new object instance
   * that finds one running. Backups route before the catch-all of a restricted sandbox.
   */
  private prepare(): Effect.Effect<void, ServiceError> {
    this.prepared ??= (async () => {
      const container = this.container();
      // Backups route to their gateway before any catch-all, which would take them.
      await this.backups().intercept();
      await this.registerEgress(container);
      await container.setInactivityTimeout(INACTIVITY_BACKSTOP_MS);
      const created = await exec.run(container, ["mkdir", "-p", WORKSPACE]);
      if (created.exitCode !== 0) throw new Error(`mkdir ${WORKSPACE} failed: ${created.stderr}`);
    })().catch((error: unknown) => {
      this.prepared = undefined;
      throw error;
    });
    const prepared = this.prepared;
    return io("sandbox.prepare", () => prepared).pipe(
      Effect.timeoutFail({
        duration: PREPARE_TIMEOUT_MS,
        onTimeout: () =>
          new TransportFailure({
            operation: "sandbox.prepare",
            cause: new Error("The sandbox container did not become ready within 3 minutes"),
          }),
      }),
      Effect.tapError(() =>
        Effect.sync(() => {
          if (this.prepared === prepared) this.prepared = undefined;
        }),
      ),
    );
  }
  /** Boundary runner: a failure is thrown as itself so its RPC wire name survives. */
  private run<A, E>(program: Effect.Effect<A, E>): Promise<A> {
    // lint: entrypoint
    return runPromise(program);
  }
  /**
   * A restricted sandbox sends every HTTP and HTTPS request to `SandboxEgress`. Registering
   * again replaces the handler, so a changed allow-list applies to the running container.
   */
  private async registerEgress(container: Container): Promise<void> {
    const settings = this.settings();
    if (settings.access !== "restricted") return;
    const egress = exported<EntrypointLoopback<SandboxEgressProps>>(
      this.ctx,
      "SandboxEgress",
    )({ props: { allowed: settings.allowed } });
    await container.interceptAllOutboundHttp(egress);
    await container.interceptOutboundHttps("*", egress);
    const trusted = await exec.run(container, ["sh", "-c", TRUST], { timeoutMs: 20_000 });
    if (trusted.exitCode !== 0) throw new Error("The sandbox did not trust the egress CA");
  }
  /** The container, running and prepared, held busy while `use` runs. */
  private use<A>(operation: string, use: (container: Container) => Promise<A>): Promise<A> {
    return this.run(
      this.lease.hold(
        this.lease.acquire.pipe(
          Effect.zipRight(this.prepare()),
          Effect.zipRight(io(operation, () => use(this.container()))),
        ),
      ),
    );
  }

  // --- Lifecycle ------------------------------------------------------------------------

  /** Store the network policy and variables; the next container starts with them. */
  async configure(network: HostedConfiguration["network"], env: Record<string, string> = {}) {
    const access = network?.access ?? "enabled";
    const running = this.lease.state()._tag === "running" && this.container().running;
    if (running && access !== this.settings().access) throw new NetworkPolicyConflict();
    const settings: Settings = {
      access,
      allowed: access === "restricted" ? (network?.allowed_domains ?? []) : [],
      env,
    };
    this.ctx.storage.kv.put("settings", settings);
    // A running container keeps its intercepts; register the new allow-list on it, without
    // touching the backup route (re-registering it could race an operation in flight).
    if (running && access === "restricted")
      await this.run(io("sandbox.egress", () => this.registerEgress(this.container())));
  }
  /** Whether a container runs for this sandbox now. */
  running(): boolean {
    return this.lease.state()._tag === "running" && (this.ctx.container?.running ?? false);
  }
  /** A turn is using the sandbox; keeps it from idling out between tool calls. */
  touch(): Promise<void> {
    return this.run(this.lease.touch);
  }
  /** Ends the container; uncommitted workspace state goes with it. */
  stop(reason: string): Promise<void> {
    return this.run(this.lease.stop(reason));
  }
  /** The session was deleted: end the container and refuse to start another. */
  release(): Promise<void> {
    return this.run(this.lease.retire);
  }
  override alarm(): Promise<void> {
    return this.run(this.lease.wake);
  }

  // --- Workspace operations --------------------------------------------------------------

  exec(argv: string[], options: SandboxExecOptions = {}): Promise<exec.ExecResult> {
    return this.use("sandbox.exec", (container) =>
      exec.run(container, argv, {
        ...options,
        // Sandbox SDK 0.x ran commands in /workspace; keep that default for callers.
        cwd: options.cwd ?? WORKSPACE,
        env: this.commandEnv(options.env),
      }),
    );
  }
  readFile(path: string, maxBytes = 16 * 1024 * 1024): Promise<string> {
    return this.use("sandbox.readFile", (container) => exec.readText(container, path, maxBytes));
  }
  writeFile(path: string, content: string | Uint8Array): Promise<void> {
    return this.use("sandbox.writeFile", (container) => exec.writeFile(container, path, content));
  }
  /**
   * Writes the `CHECKPOINTS` object `key` to `path`, streaming it inside this object: a
   * stream handed across RPC while the container boots disconnects. False when it is gone.
   */
  writeObject(path: string, key: string): Promise<boolean> {
    return this.use("sandbox.writeObject", async (container) => {
      const object = await this.env.CHECKPOINTS.get(key);
      if (!object) return false;
      await exec.writeFile(container, path, object.body);
      return true;
    });
  }
  /** Copies a file of exactly `size` bytes to the `CHECKPOINTS` object `key`. */
  copyToObject(path: string, key: string, size: number): Promise<void> {
    return this.use("sandbox.copyToObject", async (container) => {
      const source = await exec.readStream(container, path);
      const sized = new FixedLengthStream(size);
      // A failed put must also end the copy, or the pipe and `cat` would wait forever.
      const copy = new AbortController();
      try {
        await Promise.all([
          source.pipeTo(sized.writable, { signal: copy.signal }),
          this.env.CHECKPOINTS.put(key, sized.readable, {
            httpMetadata: { contentType: "application/octet-stream" },
          }).catch((error: unknown) => {
            copy.abort(error);
            throw error;
          }),
        ]);
      } finally {
        if (!source.locked) await source.cancel().catch(ignore);
      }
    });
  }
  mkdir(path: string): Promise<void> {
    return this.use("sandbox.mkdir", (container) => exec.mkdir(container, path));
  }
  remove(path: string): Promise<void> {
    return this.use("sandbox.remove", (container) => exec.remove(container, path));
  }
  exists(path: string): Promise<boolean> {
    return this.use("sandbox.exists", (container) => exec.exists(container, path));
  }
  list(directory: string): Promise<exec.ListedFile[]> {
    return this.use("sandbox.list", (container) => exec.list(container, directory));
  }
  /**
   * Starts `argv` as a long-lived server unless something already listens on `port`, and
   * waits until it does. Its output is not read, so it outlives the request. The command is
   * stored, so a proxied request starts it again in a container that replaced this one
   * (after an idle stop or a platform restart) instead of finding nothing on the port.
   */
  serve(argv: string[], port: number): Promise<void> {
    this.ctx.storage.kv.put(`server:${port}`, argv);
    return this.use("sandbox.serve", (container) => this.ensureServer(container, port));
  }
  private async ensureServer(container: Container, port: number): Promise<void> {
    if (this.listening.has(port)) return;
    if (await exec.listening(container, port)) {
      this.listening.add(port);
      return;
    }
    const argv = this.ctx.storage.kv.get<string[]>(`server:${port}`);
    if (!argv) return;
    await exec.spawn(container, argv, { cwd: WORKSPACE, env: this.commandEnv() });
    for (let attempt = 0; attempt < 60; attempt++) {
      if (await exec.listening(container, port)) {
        this.listening.add(port);
        return;
      }
      await scheduler.wait(500);
    }
    throw new Error(`Nothing listens on port ${port}`);
  }
  /**
   * One workspace tool call (bash, read, write, edit) as NDJSON: output deltas, then a
   * result or an error. Cancelling the stream stops the command and what it started.
   */
  workspaceTool(input: unknown): ReadableStream<Uint8Array> {
    const controller = new AbortController();
    const encoder = new TextEncoder();
    // Workers RPC carries byte streams.
    return new ReadableStream({
      type: "bytes",
      start: (stream) => {
        // The consumer may cancel at any time; output after that has nowhere to go.
        const line = (value: unknown) => {
          if (controller.signal.aborted) return;
          try {
            stream.enqueue(encoder.encode(`${JSON.stringify(value)}\n`));
          } catch {
            controller.abort();
          }
        };
        const close = () => {
          if (controller.signal.aborted) return;
          try {
            stream.close();
          } catch {
            controller.abort();
          }
        };
        this.use("sandbox.tool", (container) =>
          executeWorkspaceTool(container, input, {
            env: this.commandEnv(),
            signal: controller.signal,
            onOutput: (text) => line({ type: "delta", text }),
          }),
        ).then(
          (result) => {
            line({ type: "result", ...result });
            close();
          },
          (error: unknown) => {
            line({
              type: "error",
              message: error instanceof Error ? error.message : String(error),
            });
            close();
          },
        );
      },
      cancel: () => controller.abort(),
    });
  }

  // --- Backups ---------------------------------------------------------------------------

  /** Back up `/workspace` to `BACKUP_BUCKET`; the record restores it into any later container. */
  backup(): Promise<DirectoryBackupRecord> {
    return this.use("sandbox.backup", () =>
      this.backups().backup({ dir: WORKSPACE, signal: AbortSignal.timeout(BACKUP_TIMEOUT_MS) }),
    );
  }
  /**
   * Replace `/workspace` with a backup. A handle written by Sandbox SDK 0.x points at a
   * SquashFS image; it is unpacked in place, and the next checkpoint stores the 1.0 form.
   */
  restore(backup: WorkspaceBackup): Promise<void> {
    if (!isLegacy(backup))
      return this.use("sandbox.restore", () =>
        this.backups().restore(backup, { signal: AbortSignal.timeout(BACKUP_TIMEOUT_MS) }),
      );
    return this.use("sandbox.restore.legacy", async (container) => {
      const image = await this.env.BACKUP_BUCKET.get(`backups/${backup.id}/data.sqsh`);
      if (!image) throw new StoredObjectMissing({ object: "workspace_backup" });
      const script =
        'cat > "$1" && rm -rf -- "$2" && unsquashfs -no-progress -d "$2" "$1" > /dev/null; code=$?; rm -f -- "$1"; exit $code';
      const result = await exec.run(
        container,
        ["sh", "-c", script, "sh", `/var/tmp/${backup.id}.sqsh`, backup.dir],
        { stdin: image.body, timeoutMs: 10 * 60 * 1000 },
      );
      if (result.exitCode !== 0)
        throw new TransportFailure({ operation: "sandbox.restore.legacy", cause: result.stderr });
    });
  }

  // --- Container ports -------------------------------------------------------------------

  /**
   * `sandbox.internal` reaches Codex's `exec-server` (a WebSocket) and
   * `environment-mcp.internal` the MCP bridge. The socket keeps this object active; the
   * harness touches the lease while its turn runs.
   */
  override async fetch(request: Request): Promise<Response> {
    const hostname = new URL(request.url).hostname;
    const port = SANDBOX_PORTS[hostname];
    if (!port) return new Response("Unknown sandbox host", { status: 404 });
    return this.use("sandbox.proxy", async (container) => {
      await this.ensureServer(container, port);
      return container.getTcpPort(port).fetch(request);
    });
  }
}
