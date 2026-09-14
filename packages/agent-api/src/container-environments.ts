import { getSandbox, type ISandbox } from "@cloudflare/sandbox";
import { Effect, Exit } from "effect";
import type { EnvironmentInfo } from "openai/resources/beta/agents/environments/environments";
import type { z } from "zod";
import { installCapabilityArchive } from "./capability-archive.js";
import type { ContainerBindings } from "./containers.js";
import { attempt, io, type ServiceError } from "./effect.js";
import {
  base64Size,
  CAPABILITY_BYTES_LIMIT,
  type EnvironmentFileInput,
  hostedConfigurationSchema,
} from "./environment-config.js";
import type {
  EnvironmentDriver,
  EnvironmentSpec,
  environmentFilePageSchema,
} from "./environments.js";
import { ApiError, parse } from "./protocol.js";
import type { Checkpoint } from "./runtime.js";
import { SqlStore } from "./storage.js";

type Upload = { id: string; key: string; path: string; size: number; version: number };
/** A skill or plugin archive to install; inline data or an immutable R2 object. */
interface Capability {
  kind: "skill" | "plugin";
  name: string;
  description: string;
  source: { type: "base64"; data: string } | { type: "object"; key: string };
  size: number;
}
type State = {
  version: 1;
  spec: EnvironmentSpec;
  status: EnvironmentInfo["status"];
  base?: NonNullable<Checkpoint["workspace"]>;
  capabilityRoots?: string[];
  /** Adopted from a source session: the workspace was already provisioned there. */
  inherited?: boolean;
};
/** Committed state a fork copies; never the live filesystem. */
export interface ExportedEnvironment {
  base?: NonNullable<Checkpoint["workspace"]>;
  capabilityRoots: string[];
}
function comparePaths(a: string, b: string): number {
  const left = a.split("/");
  const right = b.split("/");
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    if (left[i] !== right[i]) return (left[i] ?? "") < (right[i] ?? "") ? -1 : 1;
  }
  return left.length - right.length;
}

/** Called under HarnessDO's workspace semaphore, shared by turn start, snapshots and file writes. */
export class EnvironmentWorkspace implements EnvironmentDriver {
  private readonly db: SqlStore;
  private state(): State | undefined {
    return this.db.get<State>("environment_state", "current");
  }
  private sandbox(spec: EnvironmentSpec) {
    return getSandbox(this.env.SANDBOX, spec.sessionId);
  }
  private configuration(spec: EnvironmentSpec) {
    return Effect.gen(this, function* () {
      const stored = yield* io("environment.configuration.get", () =>
        this.env.CHECKPOINTS.get(spec.configuration),
      );
      if (!stored)
        return yield* new ApiError(404, "not_found", "Environment configuration not found");
      const value = yield* io("environment.configuration.body", () => stored.json());
      return yield* attempt("environment.configuration.decode", () =>
        parse(hostedConfigurationSchema, value),
      );
    });
  }
  constructor(
    storage: DurableObjectStorage,
    private readonly env: ContainerBindings,
    /** Reads another session's committed environment state; supplied by HarnessDO. */
    private readonly exportFrom?: (
      sessionId: string,
      environmentId: string,
    ) => Effect.Effect<ExportedEnvironment, ServiceError>,
  ) {
    this.db = new SqlStore(storage);
  }
  /** Committed state only. A pending or failed environment has nothing to inherit. */
  exported(environmentId: string): ExportedEnvironment {
    const state = this.state();
    if (state?.spec.id !== environmentId || state.status !== "connected")
      throw new ApiError(409, "environment_not_ready", "Source environment is not connected");
    return {
      ...(state.base ? { base: state.base } : {}),
      capabilityRoots: state.capabilityRoots ?? [],
    };
  }
  prepare(spec: EnvironmentSpec) {
    return Effect.gen(this, function* () {
      const previous = yield* attempt("environment.state", () => this.state());
      if (previous) {
        if (previous.spec.id !== spec.id)
          return yield* new ApiError(
            409,
            "environment_conflict",
            "Harness already owns another environment",
          );
        if (previous.status === "connected") return;
        return yield* new ApiError(
          409,
          "outcome_unknown",
          "Environment setup did not complete; create a new session",
        );
      }
      const inherited = spec.inherited;
      if (inherited && !this.exportFrom)
        return yield* new ApiError(
          422,
          "unsupported_capability",
          "This environment driver cannot inherit a workspace",
        );
      yield* attempt("environment.reserve", () =>
        this.db.put("environment_state", "current", {
          version: 1,
          spec,
          status: "pending",
        } satisfies State),
      );
      // Failure and interruption both leave a durable terminal state. Setup commands
      // may have external effects, so neither a retry nor an eviction replays them.
      yield* (inherited ? this.adopt(spec, inherited) : this.setup(spec)).pipe(
        Effect.onExit((exit) =>
          Exit.isFailure(exit)
            ? attempt("environment.fail", () =>
                this.db.put("environment_state", "current", {
                  version: 1,
                  spec,
                  status: "failed",
                } satisfies State),
              ).pipe(Effect.orDie)
            : Effect.void,
        ),
      );
    });
  }
  /** A fork: adopt the source's committed workspace and capability roots without rerunning setup. */
  private adopt(spec: EnvironmentSpec, inherited: NonNullable<EnvironmentSpec["inherited"]>) {
    return Effect.gen(this, function* () {
      const source = yield* (this.exportFrom ?? (() => Effect.die("unreachable")))(
        inherited.sessionId,
        inherited.environmentId,
      );
      // Network policy, variables and packages belong to this session's own sandbox and
      // must be in place before anything starts it. Files, skills and setup commands
      // already ran in the source session; only their committed results are adopted.
      yield* this.configure(spec);
      const base = inherited.workspace ?? source.base;
      // The fresh sandbox now holds the inherited workspace, so the first turn continues in it.
      if (base)
        yield* io("environment.adopt.restore", () => this.sandbox(spec).restoreBackup(base));
      yield* attempt("environment.adopt", () =>
        this.db.put("environment_state", "current", {
          version: 1,
          spec,
          status: "connected",
          ...(base ? { base } : {}),
          capabilityRoots: source.capabilityRoots,
          inherited: true,
        } satisfies State),
      );
    });
  }
  private setup(spec: EnvironmentSpec) {
    return Effect.gen(this, function* () {
      const sandbox = this.sandbox(spec);
      const config = yield* this.configuration(spec);
      yield* this.configure(spec, config);
      yield* io("environment.mkdir", () => sandbox.mkdir("/workspace", { recursive: true }));
      yield* Effect.forEach(config.files ?? [], (file) => this.write(sandbox, spec, file), {
        discard: true,
      });
      // Archives are written one at a time and pinned bundles stream from R2, so the
      // Worker never holds more than one inline archive in memory.
      const capabilities: Capability[] = [
        ...(config.skills ?? []).flatMap((skill) =>
          skill.type === "inline"
            ? [
                {
                  kind: "skill" as const,
                  name: skill.name,
                  description: skill.description,
                  source: { type: "base64" as const, data: skill.source.data },
                  size: base64Size(skill.source.data),
                },
              ]
            : [],
        ),
        ...(config.plugins ?? []).map((plugin) => ({
          kind: "plugin" as const,
          name: plugin.name,
          description: plugin.description,
          source: { type: "base64" as const, data: plugin.source.data },
          size: base64Size(plugin.source.data),
        })),
      ];
      for (const skill of spec.skills ?? []) {
        const head = yield* io("environment.skill.head", () =>
          this.env.CHECKPOINTS.head(skill.key),
        );
        if (!head) return yield* new ApiError(404, "not_found", "Pinned skill bundle not found");
        capabilities.push({
          kind: "skill",
          name: skill.name,
          description: skill.description,
          source: { type: "object", key: skill.key },
          size: head.size,
        });
      }
      if (
        capabilities.reduce((sum, capability) => sum + capability.size, 0) > CAPABILITY_BYTES_LIMIT
      )
        return yield* new ApiError(
          413,
          "capability_limit",
          "Skills and plugins exceed 64 MiB per environment",
        );
      const installed = yield* Effect.forEach(capabilities, (capability, index) =>
        Effect.gen(this, function* () {
          const archive = `/tmp/cf-capability-${index}.zip`;
          return yield* Effect.acquireUseRelease(
            Effect.gen(this, function* () {
              const source = capability.source;
              if (source.type === "base64")
                return yield* io("environment.capability.write", () =>
                  sandbox.writeFile(archive, source.data, { encoding: "base64" }),
                );
              const key = source.key;
              const object = yield* io("environment.skill.get", () =>
                this.env.CHECKPOINTS.get(key),
              );
              if (!object)
                return yield* new ApiError(404, "not_found", "Pinned skill bundle not found");
              return yield* io("environment.capability.stream", () =>
                sandbox.writeFile(archive, object.body),
              );
            }),
            () =>
              this.command(sandbox, [
                "python3",
                "-c",
                installCapabilityArchive,
                archive,
                `/workspace/.capabilities/${index}`,
                capability.kind,
                capability.name,
                capability.description,
              ]).pipe(
                Effect.flatMap((output) =>
                  attempt("environment.capability.root", () => {
                    const root: unknown = JSON.parse(output.stdout);
                    if (typeof root !== "string" || !root.startsWith("/workspace/.capabilities/"))
                      throw new ApiError(
                        422,
                        "environment_setup_failed",
                        "Invalid capability installation result",
                      );
                    return root;
                  }),
                ),
              ),
            () =>
              io("environment.capability.release", () => sandbox.deleteFile(archive)).pipe(
                Effect.ignore,
              ),
          );
        }),
      );
      const capabilityRoots = [...(config.capability_directories ?? []), ...installed];
      yield* Effect.forEach(
        config.setup_commands ?? [],
        (command) =>
          this.command(sandbox, ["/bin/bash", "-lc", command.command], command.cwd ?? "/workspace"),
        { discard: true },
      );
      const base = yield* io("environment.backup", () =>
        sandbox.createBackup({
          dir: "/workspace",
          localBucket: this.env.LOCAL_BACKUPS === "true",
          ttl: 30 * 24 * 60 * 60,
        }),
      );
      yield* attempt("environment.commit", () =>
        this.db.put("environment_state", "current", {
          version: 1,
          spec,
          status: "connected",
          base,
          capabilityRoots,
        } satisfies State),
      );
    });
  }
  configure(spec: EnvironmentSpec, configuration?: z.infer<typeof hostedConfigurationSchema>) {
    return Effect.gen(this, function* () {
      const config = configuration ?? (yield* this.configuration(spec));
      const stub = this.env.SANDBOX.getByName(spec.sessionId);
      yield* io("environment.network", () => stub.configureNetwork(config.network));
      const sandbox = this.sandbox(spec);
      yield* io("environment.variables", () => sandbox.setEnvVars(config.env ?? {}));
      if (config.packages?.system?.length) {
        yield* this.command(sandbox, ["apt-get", "update"]);
        yield* this.command(sandbox, ["apt-get", "install", "-y", "--", ...config.packages.system]);
      }
      if (config.packages?.python?.length)
        yield* this.command(sandbox, [
          "python3",
          "-m",
          "pip",
          "install",
          "--",
          ...config.packages.python,
        ]);
      if (config.packages?.npm?.length)
        yield* this.command(sandbox, ["npm", "install", "--global", "--", ...config.packages.npm]);
    });
  }
  private command(sandbox: ISandbox, argv: [string, ...string[]], cwd = "/workspace") {
    return Effect.acquireUseRelease(
      io("environment.command.start", () => sandbox.exec(argv, { cwd, timeout: 120_000 })),
      (process) =>
        io("environment.command.output", () => process.output({ encoding: "utf8" })).pipe(
          Effect.filterOrFail(
            (output) => output.exitCode === 0,
            () => new ApiError(422, "environment_setup_failed", "Environment command failed"),
          ),
        ),
      (process, exit) =>
        Exit.isFailure(exit)
          ? io("environment.command.kill", () => process.kill()).pipe(Effect.ignore)
          : Effect.void,
    );
  }
  private write(sandbox: ISandbox, spec: EnvironmentSpec, file: EnvironmentFileInput) {
    return Effect.gen(this, function* () {
      const reference = file.type === "file_id" ? spec.inputFiles?.[file.file_id] : undefined;
      const object = reference
        ? yield* io("environment.file.get", () => this.env.CHECKPOINTS.get(reference.key))
        : undefined;
      if (file.type === "file_id" && !object)
        return yield* new ApiError(404, "not_found", "Input file not found");
      const size = file.type === "inline" ? base64Size(file.data) : (object?.size ?? 0);
      if (file.type === "inline" && size > 5 * 1024 * 1024)
        return yield* new ApiError(413, "file_too_large", "Inline file exceeds 5 MiB");
      yield* io("environment.file.mkdir", () =>
        sandbox.mkdir(file.path.slice(0, file.path.lastIndexOf("/")), { recursive: true }),
      );
      const body = file.type === "inline" ? file.data : object?.body;
      if (body === undefined) return yield* new ApiError(404, "not_found", "Input file not found");
      const written = yield* io("environment.file.write", () =>
        sandbox.writeFile(
          file.path,
          body,
          file.type === "inline" ? { encoding: "base64" } : undefined,
        ),
      );
      if (!written.success)
        return yield* new ApiError(
          503,
          "environment_write_failed",
          "Environment file write failed",
        );
      return size;
    });
  }
  base() {
    return this.state()?.base;
  }
  spec() {
    return this.state()?.spec;
  }
  capabilityRoots(): string[] {
    return this.state()?.capabilityRoots ?? [];
  }
  inherited(): boolean {
    return this.state()?.inherited ?? false;
  }
  status(spec: EnvironmentSpec) {
    return Effect.gen(this, function* () {
      const state = yield* attempt("environment.state", () => this.state());
      if (!state || state.spec.id !== spec.id) return "pending" as const;
      if (state.status !== "connected") return state.status;
      const runtime = yield* io(
        "environment.status",
        async () => await this.env.SANDBOX.getByName(spec.sessionId).getState(),
      );
      return runtime.status === "running" || runtime.status === "healthy"
        ? ("connected" as const)
        : ("disconnected" as const);
    });
  }
  upload(spec: EnvironmentSpec, file: EnvironmentFileInput) {
    return Effect.gen(this, function* () {
      const state = yield* attempt("environment.state", () => this.state());
      if (state?.spec.id !== spec.id || state.status !== "connected")
        return yield* new ApiError(
          409,
          "environment_not_ready",
          "Wait for the environment to connect",
        );
      const source = file.type === "file_id" ? spec.inputFiles?.[file.file_id] : undefined;
      const object = source
        ? yield* io("environment.upload.get", () => this.env.CHECKPOINTS.get(source.key))
        : undefined;
      if (file.type === "file_id" && !object)
        return yield* new ApiError(404, "not_found", "Input file not found");
      const size = file.type === "inline" ? base64Size(file.data) : (source?.size ?? 0);
      const version = yield* attempt("environment.upload.version", () => this.fileVersion() + 1);
      const upload: Upload = {
        id: String(version),
        path: file.path,
        key: `environments/${spec.sessionId}/uploads/${version}`,
        size,
        version,
      };
      const bytes =
        file.type === "inline"
          ? yield* attempt("environment.upload.decode", () =>
              Uint8Array.from(atob(file.data), (char) => char.charCodeAt(0)),
            )
          : object?.body;
      if (!bytes) return yield* new ApiError(404, "not_found", "Input file not found");
      yield* io("environment.upload.store", () => this.env.CHECKPOINTS.put(upload.key, bytes));
      // Commit the desired write before touching the live filesystem. A crash or a
      // lost response can then be reconciled from immutable R2 bytes after restore.
      yield* attempt("environment.upload.commit", () =>
        this.db.transaction(() => {
          this.db.put("environment_upload", upload.id, upload);
          this.db.put("environment_state", "file_version", version);
        }),
      );
      const applied = yield* attempt(
        "environment.upload.applied",
        () => this.db.get<number>("environment_state", "applied_file_version") ?? 0,
      );
      yield* this.applyUploads(applied);
      return {
        object: "agent.environment.file" as const,
        environment_id: spec.id,
        path: file.path,
        size_bytes: size,
      };
    });
  }
  fileVersion(): number {
    return this.db.get<number>("environment_state", "file_version") ?? 0;
  }
  applyUploads(afterVersion: number) {
    return Effect.gen(this, function* () {
      const spec = yield* attempt("environment.state", () => this.spec());
      if (!spec) return;
      const sandbox = this.sandbox(spec);
      let after: string | undefined;
      do {
        const page = yield* attempt("environment.upload.list", () =>
          this.db.list<Upload>("environment_upload", { order: "asc", limit: 100, after }),
        );
        yield* Effect.forEach(
          page.data,
          (upload) =>
            Effect.gen(this, function* () {
              if (upload.version <= afterVersion) return;
              const object = yield* io("environment.upload.get", () =>
                this.env.CHECKPOINTS.get(upload.key),
              );
              if (!object)
                return yield* new ApiError(
                  503,
                  "environment_write_failed",
                  "Environment upload missing",
                );
              yield* io("environment.upload.mkdir", () =>
                sandbox.mkdir(upload.path.slice(0, upload.path.lastIndexOf("/")), {
                  recursive: true,
                }),
              );
              const result = yield* io("environment.upload.apply", () =>
                sandbox.writeFile(upload.path, object.body),
              );
              if (!result.success)
                return yield* new ApiError(
                  503,
                  "environment_write_failed",
                  "Environment upload write failed",
                );
              yield* attempt("environment.upload.applied", () =>
                this.db.put("environment_state", "applied_file_version", upload.version),
              );
            }),
          { discard: true },
        );
        after = page.has_more ? (page.last_id ?? undefined) : undefined;
      } while (after);
    });
  }
  files(spec: EnvironmentSpec, query: z.infer<typeof environmentFilePageSchema>) {
    return Effect.gen(this, function* () {
      const state = yield* attempt("environment.state", () => this.state());
      if (state?.spec.id !== spec.id)
        return yield* new ApiError(404, "not_found", "Environment not found");
      const applied = yield* attempt(
        "environment.upload.applied",
        () => this.db.get<number>("environment_state", "applied_file_version") ?? 0,
      );
      yield* this.applyUploads(applied);
      const result = yield* io("environment.files.list", () =>
        this.sandbox(spec).listFiles("/workspace", { recursive: true, includeHidden: true }),
      );
      if (!result.success)
        return yield* new ApiError(503, "environment_list_failed", "Environment listing failed");
      let files = result.files
        .filter(
          (file) =>
            file.type === "file" &&
            (!query.path || file.absolutePath.startsWith(`${query.path.replace(/\/$/, "")}/`)),
        )
        .sort((a, b) => comparePaths(a.absolutePath, b.absolutePath));
      if (query.order === "desc") files.reverse();
      if (query.page) {
        const encoded = query.page;
        const cursor = yield* Effect.try({
          try: (): unknown =>
            JSON.parse(
              new TextDecoder("utf-8", { fatal: true }).decode(
                Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0)),
              ),
            ),
          catch: () => new ApiError(400, "invalid_cursor", "Invalid environment file cursor"),
        });
        if (
          !Array.isArray(cursor) ||
          cursor[0] !== spec.id ||
          cursor[1] !== query.order ||
          cursor[2] !== (query.path ?? null) ||
          typeof cursor[3] !== "string"
        )
          return yield* new ApiError(
            400,
            "invalid_cursor",
            "Cursor does not belong to this listing",
          );
        const path = cursor[3];
        files = files.filter((file) =>
          query.order === "asc"
            ? comparePaths(file.absolutePath, path) > 0
            : comparePaths(file.absolutePath, path) < 0,
        );
      }
      const data = files.slice(0, query.limit).map((file) => ({
        object: "agent.environment.file" as const,
        environment_id: spec.id,
        path: file.absolutePath,
        size_bytes: file.size,
      }));
      const has_more = files.length > query.limit;
      return {
        object: "list" as const,
        data,
        has_more,
        next: has_more
          ? btoa(
              String.fromCharCode(
                ...new TextEncoder().encode(
                  JSON.stringify([spec.id, query.order, query.path ?? null, data.at(-1)?.path]),
                ),
              ),
            )
          : null,
      };
    });
  }
}
