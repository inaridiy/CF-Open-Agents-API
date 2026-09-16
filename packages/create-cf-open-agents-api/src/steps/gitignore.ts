import { join } from "node:path";

import type { Files } from "../fs.js";
import type { StepResult } from "../plan.js";
import { VENDOR_DIRECTORY } from "../versions.js";

export const IGNORED = [`${VENDOR_DIRECTORY}/`, ".dev.vars"] as const;

/** Appends the snapshot directory and the local secrets file once. */
export function ensureGitignore(files: Files): StepResult {
  const path = join(files.root, ".gitignore");
  const existing = files.read(path) ?? "";
  const lines = existing.split(/\r?\n/);
  const present = new Set(lines.map((line) => line.trim()));
  const missing = IGNORED.filter(
    (entry) => !present.has(entry) && !present.has(entry.replace(/\/$/, "")),
  );
  if (missing.length === 0) return { status: "skipped", file: ".gitignore" };
  while (lines.length > 0 && lines.at(-1) === "") lines.pop();
  if (lines.length > 0) lines.push("");
  lines.push("# CF-Open-Agents-API image snapshot and local secrets", ...missing);
  return files.write(path, `${lines.join("\n")}\n`);
}
