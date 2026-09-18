import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

import type { PackageManager } from "./exec.js";
import { CliError } from "./plan.js";

export type ProjectMode = "retrofit" | "standalone";

export interface Project {
  root: string;
  mode: ProjectMode;
  /** `wrangler.jsonc` or `wrangler.json`; the standalone skeleton creates `wrangler.jsonc`. */
  configPath: string;
  packageManager: PackageManager;
}

export interface WranglerBinding {
  binding?: string;
  name?: string;
  class_name?: string;
  script_name?: string;
  bucket_name?: string;
  service?: string;
  entrypoint?: string;
}
export interface WranglerContainer {
  class_name?: string;
  name?: string;
  image?: string;
  image_build_context?: string;
  instance_type?: string;
  max_instances?: number;
}
export interface WranglerMigration {
  tag?: string;
  new_classes?: string[];
  new_sqlite_classes?: string[];
  renamed_classes?: { from?: string; to?: string }[];
}
/** The parts of a Wrangler configuration the CLI reads; everything else is left alone. */
export interface WranglerConfig {
  name?: string;
  main?: string;
  compatibility_date?: string;
  compatibility_flags?: string[];
  workers_dev?: boolean;
  durable_objects?: { bindings?: WranglerBinding[] };
  migrations?: WranglerMigration[];
  containers?: WranglerContainer[];
  r2_buckets?: WranglerBinding[];
  services?: WranglerBinding[];
  vars?: Record<string, unknown>;
  ai?: { binding?: string };
  worker_loaders?: WranglerBinding[];
  env?: Record<string, unknown>;
}

const CONFIG_FILES = ["wrangler.jsonc", "wrangler.json"] as const;

/** Finds the Wrangler configuration; a directory without one becomes a new project. */
export function locateProject(root: string, userAgent?: string): Project {
  const configPath = CONFIG_FILES.map((file) => join(root, file)).find((path) => existsSync(path));
  if (!configPath && existsSync(join(root, "wrangler.toml")))
    throw new CliError(
      "wrangler.toml is not supported; convert it to wrangler.jsonc first (wrangler types can help).",
    );
  if (!configPath && existsSync(join(root, "packages", "supervisor", "package.json")))
    throw new CliError(
      `${root} looks like the CF-Open-Agents-API repository; run the CLI in your own project (or pass a directory).`,
    );
  return {
    root,
    mode: configPath ? "retrofit" : "standalone",
    configPath: configPath ?? join(root, "wrangler.jsonc"),
    packageManager: detectPackageManager(root, userAgent),
  };
}

/**
 * The `packageManager` field, then a lockfile, then the package manager that runs this CLI
 * (`npm_config_user_agent`, so `pnpm dlx ... init` in an empty directory is a pnpm project).
 */
export function detectPackageManager(root: string, userAgent?: string): PackageManager {
  const manifest = readManifest(root);
  const declared = typeof manifest?.packageManager === "string" ? manifest.packageManager : "";
  for (const manager of ["pnpm", "yarn", "bun"] as const)
    if (declared.startsWith(manager)) return manager;
  if (existsSync(join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(root, "yarn.lock"))) return "yarn";
  if (existsSync(join(root, "bun.lock")) || existsSync(join(root, "bun.lockb"))) return "bun";
  for (const manager of ["pnpm", "yarn", "bun"] as const)
    if (userAgent?.startsWith(`${manager}/`)) return manager;
  return "npm";
}

export function readManifest(root: string): Record<string, unknown> | undefined {
  const path = join(root, "package.json");
  if (!existsSync(path)) return;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    throw new CliError("package.json is not valid JSON");
  }
}

/** A Worker name from a directory name: lowercase, dashes, no leading or trailing dash. */
export function workerNameFrom(root: string): string {
  const name = basename(root)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return name || "agents";
}
