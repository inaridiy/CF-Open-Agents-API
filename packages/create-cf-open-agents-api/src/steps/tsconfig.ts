import { join } from "node:path";

import type { Files } from "../fs.js";
import { appendItem, collapsePrimitiveArrays, openJsonc, parseJsonc } from "../jsonc.js";
import type { StepResult } from "../plan.js";
import { VENDOR_DIRECTORY } from "../versions.js";

interface TsConfig {
  include?: string[];
  exclude?: string[];
}

/** Keeps the snapshot out of a tsconfig that would otherwise scan it. */
export function ensureTsconfigExclude(files: Files): StepResult {
  const path = join(files.root, "tsconfig.json");
  const text = files.read(path);
  if (text === undefined) return { status: "skipped", file: "tsconfig.json" };
  const config = parseJsonc<TsConfig>(text, "tsconfig.json");
  const broad = !config.include || config.include.some((pattern) => pattern.includes("**"));
  const excluded = (config.exclude ?? []).some((pattern) =>
    pattern.replace(/^\.\//, "").startsWith(VENDOR_DIRECTORY),
  );
  if (!broad || excluded) return { status: "skipped", file: "tsconfig.json" };
  const document = collapsePrimitiveArrays(
    appendItem(openJsonc(text), ["exclude"], VENDOR_DIRECTORY),
  );
  return files.write(
    path,
    document.text,
    `tsconfig.json now excludes ${VENDOR_DIRECTORY}; add it to your linter's ignore list too.`,
  );
}
