import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import { run, type Runner } from "../exec.js";
import { display, readIfExists } from "../fs.js";
import { CliError, type StepResult } from "../plan.js";
import { GITHUB_REPOSITORY, LIBRARY_NAME, VENDOR_DIRECTORY } from "../versions.js";

export interface VendorOptions {
  root: string;
  /** The CLI version; the snapshot tag is `v<version>` unless `ref` says otherwise. */
  version: string;
  ref?: string;
  /** A local checkout to copy from instead of downloading the tag archive. */
  source?: string;
  force: boolean;
  dryRun: boolean;
  fetch?: typeof globalThis.fetch;
  runner?: Runner;
  env?: NodeJS.ProcessEnv;
}

export interface VendorManifest {
  name: string;
  version: string;
  ref: string;
  source: string;
  createdAt: string;
}

/**
 * The build context the two Dockerfiles need, and nothing else: the workspace root, the
 * supervisor and its one workspace dependency, which is what the `COPY` lines in
 * `docker/Harness.Dockerfile` name, plus `.dockerignore` (read by the docker CLI from the
 * context root) and the licence documents. It must move with those `COPY` lines.
 */
const SNAPSHOT_FILES = [
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.json",
  ".dockerignore",
  "LICENSE",
  "NOTICE",
] as const;
const SNAPSHOT_DIRECTORIES = ["docker", "packages/agent-api", "packages/supervisor"] as const;
const REQUIRED = [
  "docker/Harness.Dockerfile",
  "docker/Sandbox.Dockerfile",
  "packages/supervisor/package.json",
];
const EXCLUDED_DIRECTORIES = new Set(["dist", "node_modules", "test", "tests", ".wrangler"]);

export const SKIP_VENDOR_VARIABLE = "CF_OPEN_AGENTS_API_SKIP_VENDOR";
export const SOURCE_VARIABLE = "CF_OPEN_AGENTS_API_SOURCE";

export function vendorDirectory(root: string): string {
  return join(root, VENDOR_DIRECTORY);
}

export function readVendorManifest(root: string): VendorManifest | undefined {
  const text = readIfExists(join(vendorDirectory(root), "manifest.json"));
  if (!text) return;
  try {
    return JSON.parse(text) as VendorManifest;
  } catch {
    return;
  }
}

function isComplete(root: string): boolean {
  return REQUIRED.every((file) => existsSync(join(vendorDirectory(root), file)));
}

export interface StagedVendor {
  result: StepResult;
  /** Puts the staged snapshot in place; absent when there is nothing to write. */
  commit?: () => void;
  /** Drops the staging directory, committed or not. */
  release: () => void;
}

const nothing = () => {
  // No staging directory was created.
};

/**
 * Prepares `.cf-open-agents-api/` in a temporary directory. This is the one step that
 * downloads and shells out, so every way it can refuse — a missing archive, no `tar`, a
 * directory that is not a checkout — happens here, before `init` writes anything. `commit`
 * then only swaps two directories.
 */
export async function stageVendor(options: VendorOptions): Promise<StagedVendor> {
  const env = options.env ?? process.env;
  const target = vendorDirectory(options.root);
  const file = `${display(options.root, target)}/`;
  const ref = options.ref ?? `v${options.version}`;
  const source = options.source ?? env[SOURCE_VARIABLE];
  const expectedSource = source ? resolve(source) : "github";
  const current = readVendorManifest(options.root);
  const status = current ? "updated" : "created";
  // A complete snapshot of the wanted ref is current wherever it came from; only an
  // explicit source that differs from the recorded one replaces it.
  const sameSource = !source || current?.source === expectedSource;
  if (!options.force && current?.ref === ref && sameSource && isComplete(options.root))
    return { result: { status: "skipped", file }, release: nothing };
  if (env[SKIP_VENDOR_VARIABLE])
    return {
      result: {
        status: "skipped",
        file,
        note: `${SKIP_VENDOR_VARIABLE} is set; the image snapshot was not refreshed.`,
      },
      release: nothing,
    };
  if (options.dryRun)
    return {
      result: {
        status,
        file,
        note: `Would snapshot ${source ? resolve(source) : `${GITHUB_REPOSITORY}@${ref}`} into ${file}`,
      },
      release: nothing,
    };
  const staging = mkdtempSync(join(tmpdir(), "cf-open-agents-vendor-"));
  const release = () => rmSync(staging, { recursive: true, force: true });
  try {
    const checkout = source
      ? validateSource(resolve(source))
      : await download(ref, staging, options);
    const snapshot = join(staging, "snapshot");
    copySnapshot(checkout, snapshot);
    const manifest: VendorManifest = {
      name: LIBRARY_NAME,
      version: options.version,
      ref,
      source: expectedSource,
      createdAt: new Date().toISOString(),
    };
    writeFileSync(join(snapshot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    return { result: { status, file }, commit: () => swapSnapshot(snapshot, target), release };
  } catch (error) {
    release();
    throw error;
  }
}

/** Ensures `.cf-open-agents-api/` holds the snapshot the Dockerfiles build from. */
export async function ensureVendor(options: VendorOptions): Promise<StepResult> {
  const staged = await stageVendor(options);
  try {
    staged.commit?.();
    return staged.result;
  } finally {
    staged.release();
  }
}

function validateSource(source: string): string {
  const missing = REQUIRED.find((file) => !existsSync(join(source, file)));
  if (missing)
    throw new CliError(`${source} is not a CF-Open-Agents-API checkout: ${missing} is missing`);
  return source;
}

async function download(ref: string, staging: string, options: VendorOptions): Promise<string> {
  const url = `https://github.com/${GITHUB_REPOSITORY}/archive/${ref}.tar.gz`;
  const response = await (options.fetch ?? fetch)(url);
  if (response.status === 404)
    throw new CliError(
      `No source archive for ${ref} at ${url} yet. Pass --source <checkout> or --ref main, or set ${SOURCE_VARIABLE}=<checkout> (${SKIP_VENDOR_VARIABLE}=1 skips the snapshot).`,
    );
  if (!response.ok) throw new CliError(`Downloading ${url} failed with HTTP ${response.status}`);
  const archive = join(staging, "source.tar.gz");
  writeFileSync(archive, new Uint8Array(await response.arrayBuffer()));
  const checkout = join(staging, "checkout");
  mkdirSync(checkout);
  const tar = (options.runner ?? run)("tar", [
    "-xzf",
    archive,
    "-C",
    checkout,
    "--strip-components=1",
  ]);
  if (!tar.ok)
    throw new CliError(
      `Extracting the archive needs tar on PATH (${tar.stderr.trim()}); pass --source <checkout> instead.`,
    );
  return validateSource(checkout);
}

function keep(path: string): boolean {
  return !EXCLUDED_DIRECTORIES.has(basename(path)) && !basename(path).startsWith(".tmp-");
}

function copySnapshot(checkout: string, snapshot: string): void {
  mkdirSync(snapshot, { recursive: true });
  for (const directory of SNAPSHOT_DIRECTORIES) {
    mkdirSync(join(snapshot, directory, ".."), { recursive: true });
    cpSync(join(checkout, directory), join(snapshot, directory), { recursive: true, filter: keep });
  }
  for (const file of SNAPSHOT_FILES) {
    const from = join(checkout, file);
    if (!existsSync(from)) continue;
    mkdirSync(join(snapshot, file, ".."), { recursive: true });
    cpSync(from, join(snapshot, file));
  }
}

/** Files `init` keeps in the directory that are not part of the snapshot itself. */
const PRESERVED = ["composition.json"] as const;

const copyTree = (from: string, to: string) => cpSync(from, to, { recursive: true });

/**
 * Replaces the directory with the staged snapshot. A copy that fails halfway leaves nothing
 * half-written: the partial target goes, and what was there before comes back. On a first
 * snapshot there is nothing to come back, so the directory is removed rather than left
 * truncated — the Dockerfiles would otherwise build from a build context missing its files.
 * `copy` is the seam the failure test injects.
 */
export function swapSnapshot(snapshot: string, target: string, copy = copyTree): void {
  const previous = `${target}.previous`;
  rmSync(previous, { recursive: true, force: true });
  const restorable = existsSync(target);
  if (restorable) renameSync(target, previous);
  try {
    mkdirSync(join(target, ".."), { recursive: true });
    copy(snapshot, target);
    for (const file of PRESERVED)
      if (existsSync(join(previous, file))) cpSync(join(previous, file), join(target, file));
  } catch (error) {
    rmSync(target, { recursive: true, force: true });
    if (restorable) renameSync(previous, target);
    throw error;
  }
  rmSync(previous, { recursive: true, force: true });
}
