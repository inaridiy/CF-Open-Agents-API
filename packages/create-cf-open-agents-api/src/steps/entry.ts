import { dirname, relative } from "node:path";

import { display, type Files } from "../fs.js";
import { CliError, type StepResult } from "../plan.js";

export const EXPORTED_CLASSES = [
  "Agents",
  "Models",
  "SessionDO",
  "TenantCatalogDO",
  "HarnessDO",
  "SandboxDO",
  "ContainerEgress",
  "SandboxEgress",
  "DirectoryBackupGateway",
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

const exportStatement = (specifier: string) =>
  `export {\n${EXPORTED_CLASSES.map((name) => `  ${name},`).join("\n")}\n} from "${specifier}";`;

/**
 * Appends the class re-export to the existing entry once. An entry that re-exports the
 * classes of an older release (with `ContainerProxy`, without the egress and backup
 * entrypoints) gets the current list in place of its statement.
 */
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
  const file = display(files.root, entryPath);
  const specifier = agentsSpecifier(entryPath, agentsPath, source);
  const existing = /export\s*\{([^}]*\bSessionDO\b[^}]*)\}\s*from\s*["'][^"']+["'];?/.exec(source);
  if (existing) {
    const names = new Set(
      (existing[1] ?? "")
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean),
    );
    if (EXPORTED_CLASSES.every((name) => names.has(name)) && !names.has("ContainerProxy"))
      return { status: "skipped", file };
    // Rewrite only a plain list over a module that exports every current name: a kept
    // composition from an older release, or aliases, would not survive the rewrite.
    const agents = files.read(agentsPath) ?? "";
    const plain = [...names].every((name) => /^\w+$/.test(name));
    if (!plain || !EXPORTED_CLASSES.every((name) => new RegExp(`\\b${name}\\b`).test(agents)))
      return {
        status: "skipped",
        file,
        note: `${file} re-exports the classes of an older release; export ${EXPORTED_CLASSES.join(", ")} from ${display(files.root, agentsPath)} (regenerate it with --force) and from the entry.`,
      };
    return files.write(
      entryPath,
      source.replace(existing[0], exportStatement(specifier)),
      "The class re-export now lists the egress and backup entrypoints in place of ContainerProxy.",
    );
  }
  const separator = source.endsWith("\n") ? "" : "\n";
  return files.write(entryPath, `${source}${separator}${exportStatement(specifier)}\n`);
}
