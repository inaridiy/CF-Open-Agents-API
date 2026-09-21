import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

import type { PackageManager } from "../exec.js";
import { appendBlock, type Files } from "../fs.js";
import type { StepResult } from "../plan.js";

/** Dependencies of the generated project whose install scripts pnpm must be allowed to run. */
export const PNPM_BUILDS = ["esbuild", "workerd"] as const;

const FILE = "pnpm-workspace.yaml";

/**
 * Lets pnpm run the esbuild and workerd install scripts. pnpm 10 and later skip dependency
 * build scripts unless they are approved, and pnpm 11 then fails `pnpm exec` (which
 * re-verifies the install) with ERR_PNPM_IGNORED_BUILDS, so `wrangler dev` never starts.
 * The approval lives in `pnpm-workspace.yaml` (`allowBuilds`, the pnpm 11 form). The file
 * is only ever edited line by line: a missing `allowBuilds` block is appended, missing
 * entries are inserted under an existing one, and the pnpm 10 `onlyBuiltDependencies`
 * list counts as approval when it already names both packages.
 */
export function ensurePnpmBuilds(files: Files, packageManager: PackageManager): StepResult {
  if (packageManager !== "pnpm") return { status: "skipped", file: FILE };
  const path = join(files.root, FILE);
  const existing = files.read(path);
  if (existing === undefined) {
    const parent = workspaceRootAbove(files.root);
    if (parent)
      return {
        status: "skipped",
        file: FILE,
        note: `${files.root} is inside the pnpm workspace ${parent}; allow the ${PNPM_BUILDS.join(" and ")} build scripts in ${join(parent, FILE)} (allowBuilds) so wrangler can run.`,
      };
    return files.write(
      path,
      `allowBuilds:\n${PNPM_BUILDS.map((name) => `  ${name}: true\n`).join("")}`,
    );
  }
  const lines = existing.split(/\r?\n/);
  const missing = PNPM_BUILDS.filter((name) => !approved(lines, name));
  if (missing.length === 0) return { status: "skipped", file: FILE };
  const entries = missing.map((name) => `  ${name}: true`);
  const kept = appendBlock(lines, []);
  const block = kept.findIndex((line) => /^allowBuilds:\s*$/.test(line));
  if (block === -1) appendBlock(kept, ["allowBuilds:", ...entries], false);
  else kept.splice(block + 1, 0, ...entries);
  return files.write(path, `${kept.join("\n")}\n`);
}

/** True when `name` is allowed under `allowBuilds` or listed under `onlyBuiltDependencies`. */
function approved(lines: readonly string[], name: string): boolean {
  let section: "allowBuilds" | "onlyBuiltDependencies" | undefined;
  for (const line of lines) {
    if (/^\S/.test(line)) {
      section = undefined;
      if (/^allowBuilds:\s*$/.test(line)) section = "allowBuilds";
      else if (/^onlyBuiltDependencies:\s*$/.test(line)) section = "onlyBuiltDependencies";
      continue;
    }
    if (section === "allowBuilds" && new RegExp(`^\\s+"?${name}"?:\\s*true\\s*$`).test(line))
      return true;
    if (section === "onlyBuiltDependencies" && new RegExp(`^\\s+-\\s*"?${name}"?\\s*$`).test(line))
      return true;
  }
  return false;
}

/** The nearest ancestor directory that is a pnpm workspace root, if any. */
function workspaceRootAbove(root: string): string | undefined {
  let current = dirname(root);
  while (current !== dirname(current)) {
    if (existsSync(join(current, FILE))) return current;
    current = dirname(current);
  }
  return;
}
