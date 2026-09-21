import {
  appendItem,
  collapsePrimitiveArrays,
  type JsoncDocument,
  openJsonc,
  parseJsonc,
  setValue,
} from "../jsonc.js";
import { CliError } from "../plan.js";
import type { WranglerBinding, WranglerConfig, WranglerMigration } from "../project.js";
import { CTX_EXPORTS_DATE, VENDOR_DIRECTORY } from "../versions.js";

export interface WranglerInput {
  name: string;
  /** A Worker that composes elsewhere reaches the API through a self binding named AGENTS. */
  agentsBinding: boolean;
  workersAi: boolean;
  codeLoader: boolean;
  force: boolean;
}
export interface WranglerOutcome {
  text: string;
  notes: string[];
}

/** Binding names are fixed by `AgentBindings` and `ContainerBindings`; only the classes are exported. */
export const DURABLE_OBJECTS: readonly { name: string; class_name: string }[] = [
  { name: "SESSIONS", class_name: "SessionDO" },
  { name: "CATALOG", class_name: "TenantCatalogDO" },
  { name: "HARNESS", class_name: "HarnessDO" },
  { name: "SANDBOX", class_name: "SandboxDO" },
];
export interface ContainerSpec {
  class_name: string;
  image: string;
  image_build_context: string;
  instance_type: string;
  max_instances: number;
}
export const CONTAINERS: readonly ContainerSpec[] = [
  {
    class_name: "HarnessDO",
    image: `${VENDOR_DIRECTORY}/docker/Harness.Dockerfile`,
    image_build_context: VENDOR_DIRECTORY,
    instance_type: "basic",
    max_instances: 10,
  },
  {
    class_name: "SandboxDO",
    image: `${VENDOR_DIRECTORY}/docker/Sandbox.Dockerfile`,
    image_build_context: VENDOR_DIRECTORY,
    instance_type: "standard-1",
    max_instances: 10,
  },
];
export const BUCKETS = [
  { binding: "CHECKPOINTS", suffix: "checkpoints" },
  { binding: "BACKUP_BUCKET", suffix: "workspaces" },
] as const;

interface State {
  document: JsoncDocument;
  file: string;
  input: WranglerInput;
  notes: string[];
}
const config = (state: State) => parseJsonc<WranglerConfig>(state.document.text, state.file);
const set = (state: State, path: (string | number)[], value: unknown) => {
  state.document = setValue(state.document, path, value);
};
const append = (state: State, path: (string | number)[], value: unknown) => {
  state.document = appendItem(state.document, path, value);
};

/** Applies every section in order; `Files.write` decides whether that is a change. */
export function upsertWranglerConfig(
  text: string,
  input: WranglerInput,
  file: string,
): WranglerOutcome {
  const state: State = { document: openJsonc(text), file, input, notes: [] };
  ensureName(state);
  ensureFlags(state);
  ensureWorkerLoaders(state);
  ensureDurableObjects(state);
  ensureMigrations(state);
  ensureContainers(state);
  ensureBuckets(state);
  ensureServices(state);
  ensureBackupVariable(state);
  ensureAi(state);
  noteNamedEnvironments(state);
  if (state.document.text !== text) state.document = collapsePrimitiveArrays(state.document);
  return { text: state.document.text, notes: state.notes };
}

function ensureName(state: State): void {
  if (!config(state).name) set(state, ["name"], state.input.name);
}

function ensureFlags(state: State): void {
  const current = config(state);
  const flags = [...(current.compatibility_flags ?? [])];
  const wanted = ["nodejs_compat"];
  if ((current.compatibility_date ?? "") < CTX_EXPORTS_DATE) {
    wanted.push("enable_ctx_exports");
    if (!flags.includes("enable_ctx_exports"))
      state.notes.push(
        `compatibility_date is before ${CTX_EXPORTS_DATE}; enable_ctx_exports was added because the Container SDK needs ctx.exports.`,
      );
  }
  const missing = wanted.filter((flag) => !flags.includes(flag));
  if (missing.length === 0) return;
  set(state, ["compatibility_flags"], [...flags, ...missing]);
}

function ensureWorkerLoaders(state: State): void {
  if (!state.input.codeLoader) return;
  const loaders = config(state).worker_loaders ?? [];
  if (!loaders.some((loader) => loader.binding === "CODE_LOADER"))
    append(state, ["worker_loaders"], { binding: "CODE_LOADER" });
}

function ensureDurableObjects(state: State): void {
  const bindings = config(state).durable_objects?.bindings ?? [];
  for (const wanted of DURABLE_OBJECTS) {
    const byName = bindings.find((binding) => binding.name === wanted.name);
    const byClass = bindings.find((binding) => binding.class_name === wanted.class_name);
    if (byName && (byName.class_name !== wanted.class_name || byName.script_name))
      throw new CliError(
        `${state.file}: Durable Object binding ${wanted.name} must be class ${wanted.class_name} in this Worker (found ${byName.class_name ?? "?"}${byName.script_name ? ` in ${byName.script_name}` : ""}). The library reads env.${wanted.name}.`,
      );
    if (!byName && byClass)
      throw new CliError(
        `${state.file}: class ${wanted.class_name} is bound as ${byClass.name ?? "?"}; the library expects the binding name ${wanted.name}.`,
      );
    if (!byName) append(state, ["durable_objects", "bindings"], wanted);
  }
}

const nextTag = (tags: readonly (string | undefined)[]): string => {
  const numbers = tags.map((tag) => /^v(\d+)$/.exec(tag ?? "")?.[1]).filter((n) => n !== undefined);
  let next = numbers.length > 0 ? Math.max(...numbers.map(Number)) + 1 : tags.length + 1;
  while (tags.includes(`v${next}`)) next += 1;
  return `v${next}`;
};

/** Where a class got its storage: the migration that declared it, under the name it had then. */
export interface ClassOrigin {
  storage: "sqlite" | "kv";
  /** The declared class; `className` itself unless a `renamed_classes` chain leads to it. */
  className: string;
}

/**
 * Follows `className` back through `renamed_classes` to the migration that created it: a
 * rename carries the storage of the class it renames, so only `new_sqlite_classes` and
 * `new_classes` decide. The newest statement about a name wins, the origin of a rename is
 * looked for in the migrations before it, and a rename cycle ends the walk rather than
 * looping. `undefined` means no migration mentions the class at all.
 */
export function classOrigin(
  migrations: readonly WranglerMigration[],
  className: string,
  seen: ReadonlySet<string> = new Set(),
): ClassOrigin | undefined {
  if (seen.has(className)) return;
  const visited = new Set([...seen, className]);
  for (let index = migrations.length - 1; index >= 0; index -= 1) {
    const migration = migrations[index];
    if (migration?.new_sqlite_classes?.includes(className)) return { storage: "sqlite", className };
    if (migration?.new_classes?.includes(className)) return { storage: "kv", className };
    const renamed = migration?.renamed_classes?.find((rename) => rename.to === className);
    if (renamed?.from) return classOrigin(migrations.slice(0, index), renamed.from, visited);
  }
  return;
}

/**
 * Whether the migrations give `className` SQLite storage: declared in `new_sqlite_classes`,
 * or renamed from a class that has it. `init` and `doctor` share this rule; when they
 * disagreed, a configuration `init` accepted was reported broken by `doctor`. A rename is no
 * proof on its own — a class renamed from a `new_classes` one still has KV storage.
 */
export function isSqliteClass(configuration: WranglerConfig, className: string): boolean {
  return classOrigin(configuration.migrations ?? [], className)?.storage === "sqlite";
}

function ensureMigrations(state: State): void {
  const current = config(state);
  const migrations = current.migrations ?? [];
  const classes = DURABLE_OBJECTS.map((object) => object.class_name);
  for (const name of classes) {
    const origin = classOrigin(migrations, name);
    if (origin?.storage !== "kv") continue;
    const declared =
      origin.className === name
        ? "is declared in new_classes"
        : `was renamed from ${origin.className}, which is declared in new_classes`;
    throw new CliError(
      `${state.file}: ${name} ${declared}; the library's Durable Objects need SQLite storage (new_sqlite_classes).`,
    );
  }
  const missing = classes.filter((name) => !isSqliteClass(current, name));
  if (missing.length === 0) return;
  append(state, ["migrations"], {
    tag: nextTag(migrations.map((m) => m.tag)),
    new_sqlite_classes: missing,
  });
}

function ensureContainers(state: State): void {
  const containers = config(state).containers ?? [];
  for (const entry of CONTAINERS) {
    const index = containers.findIndex((container) => container.class_name === entry.class_name);
    const existing = containers[index];
    if (!existing) {
      append(state, ["containers"], entry);
      continue;
    }
    if (
      existing.image === entry.image &&
      existing.image_build_context === entry.image_build_context
    )
      continue;
    if (!state.input.force) {
      state.notes.push(
        `containers[${entry.class_name}] keeps image ${existing.image ?? "?"}; the snapshot Dockerfile is ${entry.image} (--force rewrites it).`,
      );
      continue;
    }
    set(state, ["containers", index, "image"], entry.image);
    set(state, ["containers", index, "image_build_context"], entry.image_build_context);
  }
}

function ensureBuckets(state: State): void {
  const buckets = config(state).r2_buckets ?? [];
  for (const wanted of BUCKETS)
    if (!buckets.some((bucket) => bucket.binding === wanted.binding))
      append(state, ["r2_buckets"], {
        binding: wanted.binding,
        bucket_name: `${state.input.name}-${wanted.suffix}`,
      });
}

function ensureServices(state: State): void {
  const wanted: WranglerBinding[] = [
    { binding: "MODEL_GATEWAY", service: state.input.name, entrypoint: "Models" },
  ];
  if (state.input.agentsBinding)
    wanted.push({ binding: "AGENTS", service: state.input.name, entrypoint: "Agents" });
  for (const service of wanted) {
    const services = config(state).services ?? [];
    const index = services.findIndex((entry) => entry.binding === service.binding);
    const existing = services[index];
    if (!existing) {
      append(state, ["services"], service);
      continue;
    }
    if (existing.service === service.service && existing.entrypoint === service.entrypoint)
      continue;
    if (!state.input.force)
      throw new CliError(
        `${state.file}: services[${service.binding}] must point at this Worker's ${service.entrypoint} entrypoint (found ${existing.service ?? "?"}#${existing.entrypoint ?? "default"}); --force rewrites it.`,
      );
    set(state, ["services", index], service);
  }
}

function ensureBackupVariable(state: State): void {
  const current = config(state);
  const bucket = current.r2_buckets?.find(
    (entry) => entry.binding === "BACKUP_BUCKET",
  )?.bucket_name;
  if (!bucket) return;
  const value = current.vars?.BACKUP_BUCKET_NAME;
  if (value === bucket) return;
  if (value !== undefined)
    state.notes.push(
      `vars.BACKUP_BUCKET_NAME now equals the BACKUP_BUCKET bucket name (${bucket}); it was ${JSON.stringify(value)}.`,
    );
  set(state, ["vars", "BACKUP_BUCKET_NAME"], bucket);
}

function ensureAi(state: State): void {
  if (!state.input.workersAi) return;
  const ai = config(state).ai;
  if (!ai) {
    // Workers AI has no local emulator; `remote: true` states that and silences the
    // `AI bindings always access remote resources` warning on every `wrangler dev`.
    set(state, ["ai"], { binding: "AI", remote: true });
    return;
  }
  if (ai.binding !== "AI")
    throw new CliError(
      `${state.file}: the Workers AI binding is ${ai.binding ?? "?"}; the generated composition reads env.AI.`,
    );
}

function noteNamedEnvironments(state: State): void {
  const environments = Object.keys(config(state).env ?? {});
  if (environments.length > 0)
    state.notes.push(
      `Named environments (${environments.join(", ")}) were not changed; Wrangler does not inherit Durable Object, R2 or service bindings into them.`,
    );
}
