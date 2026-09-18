import { join, resolve } from "node:path";

import { packageManagerExec, run, type Runner } from "./exec.js";
import { readIfExists } from "./fs.js";
import { parseJsonc } from "./jsonc.js";
import { locateProject, type Project, type WranglerConfig } from "./project.js";
import { parseDevVars } from "./steps/dev-vars.js";
import { readVendorManifest, type VendorManifest } from "./steps/vendor.js";
import { BUCKETS, CONTAINERS, DURABLE_OBJECTS } from "./steps/wrangler.js";
import { MINIMUM_TOKEN_LENGTH } from "./token.js";
import { CLI_VERSION, CTX_EXPORTS_DATE, TOOLCHAIN_VERSIONS } from "./versions.js";

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}
export interface DoctorOptions {
  dir: string;
  runner?: Runner;
  cliVersion?: string;
  /** Skip the checks that call docker and wrangler. */
  offline?: boolean;
}
export interface DoctorReport {
  checks: Check[];
  ok: boolean;
  notes: string[];
}

const check = (name: string, ok: boolean, detail: string): Check => ({ name, ok, detail });

const serviceCheck = (config: WranglerConfig, binding: string, entrypoint: string): Check => {
  const name = config.name ?? "";
  const entry = config.services?.find((item) => item.binding === binding);
  if (!entry) return check(`services.${binding}`, false, "missing");
  const ok = entry.service === name && entry.entrypoint === entrypoint;
  const found = `${entry.service ?? "?"}#${entry.entrypoint ?? "default"}`;
  return check(
    `services.${binding}`,
    ok,
    ok ? `→ ${found}` : `points at ${found}, expected ${name}#${entrypoint}`,
  );
};

function storageChecks(config: WranglerConfig): Check[] {
  const backup = config.r2_buckets?.find(
    (bucket) => bucket.binding === "BACKUP_BUCKET",
  )?.bucket_name;
  const variable = config.vars?.BACKUP_BUCKET_NAME;
  const checks = [
    check(
      "vars.BACKUP_BUCKET_NAME",
      backup !== undefined && variable === backup,
      backup === undefined
        ? "BACKUP_BUCKET binding missing"
        : `${JSON.stringify(variable)} vs bucket ${backup}`,
    ),
  ];
  for (const bucket of BUCKETS) {
    const present = config.r2_buckets?.some((entry) => entry.binding === bucket.binding) ?? false;
    checks.push(check(`r2_buckets.${bucket.binding}`, present, present ? "" : "missing"));
  }
  return checks;
}

function objectChecks(config: WranglerConfig): Check[] {
  const checks: Check[] = [];
  for (const object of DURABLE_OBJECTS) {
    const binding = config.durable_objects?.bindings?.find((entry) => entry.name === object.name);
    const ok = binding?.class_name === object.class_name;
    checks.push(
      check(
        `durable_objects.${object.name}`,
        ok,
        binding ? `class ${binding.class_name ?? "?"}` : "missing",
      ),
    );
    const sqlite =
      config.migrations?.some((migration) =>
        migration.new_sqlite_classes?.includes(object.class_name),
      ) ?? false;
    checks.push(
      check(
        `migrations.${object.class_name}`,
        sqlite,
        sqlite ? "new_sqlite_classes" : "not in new_sqlite_classes",
      ),
    );
  }
  return checks;
}

function containerChecks(config: WranglerConfig): Check[] {
  return CONTAINERS.map((container) => {
    const entry = config.containers?.find((item) => item.class_name === container.class_name);
    const ok = entry?.image === container.image;
    return check(
      `containers.${container.class_name}`,
      ok,
      entry ? `image ${entry.image ?? "?"}` : "missing",
    );
  });
}

function flagChecks(config: WranglerConfig): Check[] {
  const flags = config.compatibility_flags ?? [];
  const checks = [check("compatibility_flags.nodejs_compat", flags.includes("nodejs_compat"), "")];
  if ((config.compatibility_date ?? "") < CTX_EXPORTS_DATE)
    checks.push(
      check(
        "compatibility_flags.enable_ctx_exports",
        flags.includes("enable_ctx_exports"),
        `compatibility_date ${config.compatibility_date ?? "?"} is before ${CTX_EXPORTS_DATE}`,
      ),
    );
  return checks;
}

/** Agreement rules the Worker breaks silently when they drift; mirrors the repository's check:docs. */
export function configChecks(config: WranglerConfig): Check[] {
  const name = config.name ?? "";
  const checks = [
    check("name", name.length > 0, name || "missing"),
    serviceCheck(config, "MODEL_GATEWAY", "Models"),
  ];
  // A standalone Worker serves the API as its default export and has no AGENTS binding.
  if (config.services?.some((item) => item.binding === "AGENTS"))
    checks.push(serviceCheck(config, "AGENTS", "Agents"));
  return [
    ...checks,
    ...storageChecks(config),
    ...objectChecks(config),
    ...containerChecks(config),
    ...flagChecks(config),
  ];
}

export function snapshotCheck(manifest: VendorManifest | undefined, cliVersion: string): Check {
  if (!manifest)
    return check("image snapshot", false, "missing; run create-cf-open-agents-api vendor");
  return check(
    "image snapshot",
    manifest.version === cliVersion,
    `${manifest.version} (CLI ${cliVersion})`,
  );
}

export function devVarsCheck(text: string | undefined): Check {
  const token = text ? (parseDevVars(text).get("API_TOKEN") ?? "") : "";
  return check(
    ".dev.vars API_TOKEN",
    token.length >= MINIMUM_TOKEN_LENGTH,
    text ? `${token.length} characters` : "file missing",
  );
}

function toolChecks(project: Project, runner: Runner): Check[] {
  const exec = packageManagerExec(project.packageManager);
  const wrangler = runner(exec[0] ?? "npx", [...exec.slice(1), "wrangler", "--version"], {
    cwd: project.root,
  });
  const version = /(\d+\.\d+\.\d+)/.exec(wrangler.stdout)?.[1];
  const docker = runner("docker", ["info"], { cwd: project.root });
  const whoami = runner(exec[0] ?? "npx", [...exec.slice(1), "wrangler", "whoami"], {
    cwd: project.root,
  });
  const loggedIn =
    whoami.ok && !/not authenticated|not logged in/i.test(whoami.stdout + whoami.stderr);
  return [
    check(
      "wrangler",
      wrangler.ok && version !== undefined,
      version
        ? `${version} (this CLI was tested with ${TOOLCHAIN_VERSIONS.wrangler})`
        : "not installed",
    ),
    check(
      "docker",
      docker.ok,
      docker.ok ? "engine reachable" : "docker info failed; local containers need a running engine",
    ),
    check(
      "wrangler login",
      loggedIn,
      loggedIn
        ? "authenticated"
        : "run wrangler login (the AI binding calls your account even in wrangler dev)",
    ),
  ];
}

export function runDoctor(options: DoctorOptions): DoctorReport {
  const root = resolve(options.dir);
  const project = locateProject(root);
  const runner = options.runner ?? run;
  const major = Number(process.versions.node.split(".")[0]);
  const checks: Check[] = [check("node", major >= 24, process.versions.node)];
  const text = readIfExists(project.configPath);
  if (project.mode === "standalone" || text === undefined)
    checks.push(
      check("wrangler config", false, "no wrangler.jsonc; run create-cf-open-agents-api init"),
    );
  else checks.push(...configChecks(parseJsonc<WranglerConfig>(text, project.configPath)));
  checks.push(snapshotCheck(readVendorManifest(root), options.cliVersion ?? CLI_VERSION));
  checks.push(devVarsCheck(readIfExists(join(root, ".dev.vars"))));
  if (!options.offline) checks.push(...toolChecks(project, runner));
  return {
    checks,
    ok: checks.every((item) => item.ok),
    notes: [
      "Containers need the Workers Paid plan; deployment fails without it.",
      "Named environments (env.*) are not checked.",
    ],
  };
}

export function renderReport(report: DoctorReport): string {
  const lines = report.checks.map(
    (item) => `${item.ok ? "✔" : "✖"} ${item.name}${item.detail ? `  ${item.detail}` : ""}`,
  );
  return [...lines, "", ...report.notes.map((note) => `  - ${note}`)].join("\n");
}
