import { Effect, Exit } from "effect";
import type { EnvironmentInfo } from "openai/resources/beta/agents/environments/environments";
import type { z } from "zod";

import { installCapabilityArchive } from "./capability-archive.js";
import type { ContainerBindings } from "./containers/host.js";
import { sandboxOf, type Workspace, workspaceOf } from "./containers/workspace.js";
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
import {
  CapabilityBudgetExceeded,
  CapabilityUnsupported,
  EnvironmentConflict,
  EnvironmentListFailed,
  EnvironmentNotFound,
  EnvironmentNotReady,
  EnvironmentSetupFailed,
  EnvironmentSetupIndeterminate,
  EnvironmentWriteFailed,
  FileTooLarge,
  InvalidCursor,
  StoredObjectMissing,
} from "./errors.js";
import { kind } from "./persistence/kind.js";
import { eachRecord } from "./persistence/record-store.js";
import { parseEffect } from "./protocol.js";
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
/** Every record kind the workspace stores; two counters share the `environment_state` partition. */
const Kinds = {
  /** id `current`: the workspace state. */
  state: kind<State>("environment_state"),
  /** ids `file_version` and `applied_file_version`: the last accepted and applied upload versions. */
  fileVersion: kind<number>("environment_state"),
  upload: kind<Upload>("environment_upload"),
} as const;
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
    return this.db.get(Kinds.state, "current");
  }
  private sandbox(spec: EnvironmentSpec): Workspace {
    return workspaceOf(this.env, spec.sessionId);
  }
  private configuration(spec: EnvironmentSpec) {
    return Effect.gen(this, function* () {
      const stored = yield* io("environment.configuration.get", () =>
        this.env.CHECKPOINTS.get(spec.configuration),
      );
      if (!stored) return yield* new StoredObjectMissing({ object: "environment_configuration" });
      const value = yield* io("environment.configuration.body", () => stored.json());
      return yield* parseEffect(hostedConfigurationSchema, value);
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
      throw new EnvironmentNotReady({ reason: "source" });
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
          return yield* new EnvironmentConflict({ environmentId: previous.spec.id });
        if (previous.status === "connected") return;
        return yield* new EnvironmentSetupIndeterminate();
      }
      const inherited = spec.inherited;
      if (inherited && !this.exportFrom)
        return yield* new CapabilityUnsupported({ capability: "workspace_inheritance" });
      yield* attempt("environment.reserve", () =>
        this.db.put(Kinds.state, "current", {
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
                this.db.put(Kinds.state, "current", {
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
      // Network policy and variables belong to this session's own sandbox and must be in
      // place before anything starts it; packages follow. Files, skills and setup commands
      // already ran in the source session; only their committed results are adopted.
      const config = yield* this.configuration(spec);
      yield* this.configure(spec, config);
      const base = inherited.workspace ?? source.base;
      // The fresh sandbox now holds the inherited workspace, so the first turn continues in it.
      if (base)
        yield* io("environment.adopt.restore", () =>
          sandboxOf(this.env, spec.sessionId).restore(base),
        );
      yield* this.installPackages(spec, config);
      yield* attempt("environment.adopt", () =>
        this.db.put(Kinds.state, "current", {
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
      yield* io("environment.mkdir", () => sandbox.mkdir("/workspace"));
      yield* this.installPackages(spec, config);
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
        if (!head) return yield* new StoredObjectMissing({ object: "skill_bundle" });
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
        return yield* new CapabilityBudgetExceeded();
      const installed = yield* Effect.forEach(capabilities, (capability, index) =>
        Effect.gen(this, function* () {
          const archive = `/tmp/cf-capability-${index}.zip`;
          return yield* Effect.acquireUseRelease(
            Effect.gen(this, function* () {
              const source = capability.source;
              if (source.type === "base64") {
                const bytes = yield* attempt("environment.capability.decode", () =>
                  Uint8Array.from(atob(source.data), (char) => char.charCodeAt(0)),
                );
                return yield* io("environment.capability.write", () =>
                  sandbox.writeFile(archive, bytes),
                );
              }
              const key = source.key;
              const written = yield* io("environment.capability.stream", () =>
                sandboxOf(this.env, spec.sessionId).writeObject(archive, key),
              );
              if (!written) return yield* new StoredObjectMissing({ object: "skill_bundle" });
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
                  attempt("environment.capability.root", (): unknown => JSON.parse(output.stdout)),
                ),
                Effect.filterOrFail(
                  (root): root is string =>
                    typeof root === "string" && root.startsWith("/workspace/.capabilities/"),
                  () => new EnvironmentSetupFailed({ reason: "capability_result" }),
                ),
              ),
            () =>
              io("environment.capability.release", () => sandbox.remove(archive)).pipe(
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
        sandboxOf(this.env, spec.sessionId).backup(),
      );
      yield* attempt("environment.commit", () =>
        this.db.put(Kinds.state, "current", {
          version: 1,
          spec,
          status: "connected",
          base,
          capabilityRoots,
        } satisfies State),
      );
    });
  }
  /**
   * Store the network policy and variables in the session's SandboxDO. The container starts
   * with them, so this runs before anything starts it.
   */
  configure(spec: EnvironmentSpec, configuration?: z.infer<typeof hostedConfigurationSchema>) {
    return Effect.gen(this, function* () {
      const config = configuration ?? (yield* this.configuration(spec));
      yield* io("environment.network", () =>
        sandboxOf(this.env, spec.sessionId).configure(config.network, config.env ?? {}),
      );
    });
  }
  /** Install the configured packages into a fresh container; they live outside /workspace. */
  installPackages(
    spec: EnvironmentSpec,
    configuration?: z.infer<typeof hostedConfigurationSchema>,
  ) {
    return Effect.gen(this, function* () {
      const config = configuration ?? (yield* this.configuration(spec));
      const sandbox = this.sandbox(spec);
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
  /** A setup command: two minutes, and the whole process group ends with it. */
  private command(sandbox: Workspace, argv: [string, ...string[]], cwd = "/workspace") {
    return io("environment.command", () => sandbox.exec(argv, { cwd, timeoutMs: 120_000 })).pipe(
      Effect.filterOrFail(
        (output) => output.exitCode === 0 && !output.timedOut,
        () => new EnvironmentSetupFailed({ reason: "command" }),
      ),
    );
  }
  private write(sandbox: Workspace, spec: EnvironmentSpec, file: EnvironmentFileInput) {
    return Effect.gen(this, function* () {
      if (file.type === "inline") {
        const size = base64Size(file.data);
        if (size > 5 * 1024 * 1024) return yield* new FileTooLarge({ kind: "inline" });
        const body = yield* attempt("environment.file.decode", () =>
          Uint8Array.from(atob(file.data), (char) => char.charCodeAt(0)),
        );
        yield* io("environment.file.write", () => sandbox.writeFile(file.path, body)).pipe(
          Effect.mapError(() => new EnvironmentWriteFailed({ reason: "file" })),
        );
        return size;
      }
      const reference = spec.inputFiles?.[file.file_id];
      if (!reference) return yield* new StoredObjectMissing({ object: "input_file" });
      const written = yield* io("environment.file.write", () =>
        sandboxOf(this.env, spec.sessionId).writeObject(file.path, reference.key),
      ).pipe(Effect.mapError(() => new EnvironmentWriteFailed({ reason: "file" })));
      if (!written) return yield* new StoredObjectMissing({ object: "input_file" });
      return reference.size;
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
      const running = yield* io("environment.status", () =>
        sandboxOf(this.env, spec.sessionId).running(),
      );
      return running ? ("connected" as const) : ("disconnected" as const);
    });
  }
  upload(spec: EnvironmentSpec, file: EnvironmentFileInput) {
    return Effect.gen(this, function* () {
      const state = yield* attempt("environment.state", () => this.state());
      if (state?.spec.id !== spec.id || state.status !== "connected")
        return yield* new EnvironmentNotReady({ reason: "upload" });
      const source = file.type === "file_id" ? spec.inputFiles?.[file.file_id] : undefined;
      const object = source
        ? yield* io("environment.upload.get", () => this.env.CHECKPOINTS.get(source.key))
        : undefined;
      if (file.type === "file_id" && !object)
        return yield* new StoredObjectMissing({ object: "input_file" });
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
      if (!bytes) return yield* new StoredObjectMissing({ object: "input_file" });
      // The upload row below names this object: observe the put's outcome before committing.
      yield* Effect.uninterruptible(
        io("environment.upload.store", () => this.env.CHECKPOINTS.put(upload.key, bytes)),
      );
      // Commit the desired write before touching the live filesystem. A crash or a
      // lost response can then be reconciled from immutable R2 bytes after restore.
      yield* attempt("environment.upload.commit", () =>
        this.db.transaction(() => {
          this.db.put(Kinds.upload, upload.id, upload);
          this.db.put(Kinds.fileVersion, "file_version", version);
        }),
      );
      const applied = yield* attempt(
        "environment.upload.applied",
        () => this.db.get(Kinds.fileVersion, "applied_file_version") ?? 0,
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
    return this.db.get(Kinds.fileVersion, "file_version") ?? 0;
  }
  applyUploads(afterVersion: number) {
    return Effect.gen(this, function* () {
      const spec = yield* attempt("environment.state", () => this.spec());
      if (!spec) return;
      const uploads = yield* attempt("environment.upload.list", () => [
        ...eachRecord(this.db, Kinds.upload),
      ]);
      yield* Effect.forEach(
        uploads,
        (upload) =>
          Effect.gen(this, function* () {
            if (upload.version <= afterVersion) return;
            const written = yield* io("environment.upload.apply", () =>
              sandboxOf(this.env, spec.sessionId).writeObject(upload.path, upload.key),
            ).pipe(Effect.mapError(() => new EnvironmentWriteFailed({ reason: "upload" })));
            if (!written) return yield* new EnvironmentWriteFailed({ reason: "upload_missing" });
            yield* attempt("environment.upload.applied", () =>
              this.db.put(Kinds.fileVersion, "applied_file_version", upload.version),
            );
          }),
        { discard: true },
      );
    });
  }
  files(spec: EnvironmentSpec, query: z.infer<typeof environmentFilePageSchema>) {
    return Effect.gen(this, function* () {
      const state = yield* attempt("environment.state", () => this.state());
      if (state?.spec.id !== spec.id)
        return yield* new EnvironmentNotFound({ environmentId: spec.id });
      const applied = yield* attempt(
        "environment.upload.applied",
        () => this.db.get(Kinds.fileVersion, "applied_file_version") ?? 0,
      );
      yield* this.applyUploads(applied);
      const listed = yield* io("environment.files.list", () =>
        this.sandbox(spec).list("/workspace"),
      ).pipe(Effect.mapError(() => new EnvironmentListFailed()));
      let files = listed
        .filter(
          (file) =>
            file.type === "file" &&
            (!query.path || file.path.startsWith(`${query.path.replace(/\/$/, "")}/`)),
        )
        .map((file) => ({ absolutePath: file.path, size: file.size }))
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
          catch: () => new InvalidCursor({ reason: "Invalid environment file cursor" }),
        });
        if (
          !Array.isArray(cursor) ||
          cursor[0] !== spec.id ||
          cursor[1] !== query.order ||
          cursor[2] !== (query.path ?? null) ||
          typeof cursor[3] !== "string"
        )
          return yield* new InvalidCursor({ reason: "Cursor does not belong to this listing" });
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
