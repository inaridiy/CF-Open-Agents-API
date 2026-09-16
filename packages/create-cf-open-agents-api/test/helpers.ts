import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { Reporter } from "../dist/index.js";

export const packageRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
export const repoRoot = resolve(packageRoot, "..", "..");
export const cliPath = join(packageRoot, "dist", "cli.js");
export const fixtures = join(packageRoot, "test", "fixtures");

/** A fresh copy of a fixture in a temporary directory. */
export function copyFixture(name: string): string {
  const directory = mkdtempSync(join(tmpdir(), "cf-cli-"));
  cpSync(join(fixtures, name), directory, { recursive: true });
  return directory;
}
export function emptyDirectory(): string {
  return mkdtempSync(join(tmpdir(), "cf-cli-"));
}
export function cleanup(directory: string): void {
  rmSync(directory, { recursive: true, force: true });
}
export const read = (directory: string, file: string): string =>
  readFileSync(join(directory, file), "utf8");
export const readJson = <T>(directory: string, file: string): T =>
  JSON.parse(read(directory, file)) as T;

/** Every file under a directory with its content, for before/after comparisons. */
export function snapshot(directory: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (current: string) => {
    for (const entry of readdirSync(current)) {
      const path = join(current, entry);
      if (statSync(path).isDirectory()) walk(path);
      else files.set(path.slice(directory.length + 1), readFileSync(path, "utf8"));
    }
  };
  walk(directory);
  return files;
}

/** No downloads and no snapshot in unit tests; vendor is covered on its own. */
export const offline = { CF_OPEN_AGENTS_API_SKIP_VENDOR: "1" };
export const silent = (): Reporter => ({
  intro() {},
  info() {},
  warn() {},
  spin: (_label, work) => work(),
  note() {},
  outro() {},
});

export interface Manifest {
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
}
