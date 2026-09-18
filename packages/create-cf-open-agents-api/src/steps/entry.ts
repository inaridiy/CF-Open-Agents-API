import { dirname, relative } from "node:path";

import type { Files } from "../fs.js";
import { CliError, type StepResult } from "../plan.js";

export const EXPORTED_CLASSES = [
  "Agents",
  "Models",
  "SessionDO",
  "TenantCatalogDO",
  "HarnessDO",
  "SandboxDO",
  "ContainerProxy",
] as const;

/** The module specifier from the entry file to the composition, matching its import style. */
export function agentsSpecifier(
  entryPath: string,
  agentsPath: string,
  entrySource: string,
): string {
  const raw = relative(dirname(entryPath), agentsPath).split("\\").join("/");
  const bare = raw.replace(/\.ts$/, "");
  const withDot = bare.startsWith(".") ? bare : `./${bare}`;
  const extensioned = /from\s+["']\.{1,2}\/[^"']+\.js["']/.test(entrySource);
  return extensioned ? `${withDot}.js` : withDot;
}

/** Appends the class re-export to the existing entry once. */
export function ensureEntryExports(
  files: Files,
  entryPath: string,
  agentsPath: string,
): StepResult {
  const source = files.read(entryPath);
  if (source === undefined)
    throw new CliError(
      `The Wrangler entry ${entryPath} does not exist; point main at your Worker entry first.`,
    );
  const file = entryPath
    .slice(files.root.length + 1)
    .split("\\")
    .join("/");
  if (/export\s*\{[^}]*\bSessionDO\b[^}]*\}\s*from/.test(source))
    return { status: "skipped", file };
  const specifier = agentsSpecifier(entryPath, agentsPath, source);
  const line = `export { ${EXPORTED_CLASSES.join(", ")} } from "${specifier}";`;
  const separator = source.endsWith("\n") ? "" : "\n";
  return files.write(entryPath, `${source}${separator}${line}\n`);
}
