import { join } from "node:path";

import type { Files } from "../fs.js";
import { openJsonc, parseJsonc, setValue } from "../jsonc.js";
import { CliError, type StepResult } from "../plan.js";
import { CLI_NAME } from "../versions.js";

export interface PackageJsonOptions {
  files: Files;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  scripts: Record<string, string>;
  force: boolean;
}

interface Manifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
}

const VENDOR_SCRIPT = `${CLI_NAME} vendor`;

/** Adds pinned dependencies and the vendor hook; other versions are kept unless `--force`. */
export function ensurePackageJson(options: PackageJsonOptions): StepResult {
  const path = join(options.files.root, "package.json");
  const text = options.files.read(path);
  if (text === undefined)
    throw new CliError("package.json is missing; run this in a Node project.");
  let document = openJsonc(text);
  const notes: string[] = [];
  const kept: string[] = [];
  const upsert = (field: "dependencies" | "devDependencies", wanted: Record<string, string>) => {
    for (const [name, version] of Object.entries(wanted)) {
      const current = parseJsonc<Manifest>(document.text, "package.json")[field]?.[name];
      if (current === version) continue;
      if (current !== undefined && !options.force) {
        kept.push(`${name}@${current} (wanted ${version})`);
        continue;
      }
      document = setValue(document, [field, name], version);
    }
  };
  upsert("dependencies", options.dependencies);
  upsert("devDependencies", options.devDependencies);
  for (const [name, command] of Object.entries(options.scripts)) {
    const current = parseJsonc<Manifest>(document.text, "package.json").scripts?.[name];
    if (current === command || current?.includes(command)) continue;
    const next = name === "postinstall" && current ? `${current} && ${command}` : command;
    if (current && next === command && !options.force) {
      kept.push(`scripts.${name} (wanted ${command})`);
      continue;
    }
    document = setValue(document, ["scripts", name], next);
  }
  if (kept.length > 0)
    notes.push(`package.json kept existing entries: ${kept.join(", ")}; --force overwrites them.`);
  return options.files.write(path, document.text, notes.length > 0 ? notes.join(" ") : undefined);
}

export const vendorScript = VENDOR_SCRIPT;
