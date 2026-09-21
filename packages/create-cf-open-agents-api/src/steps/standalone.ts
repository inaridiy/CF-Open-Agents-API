import { join } from "node:path";

import type { Files } from "../fs.js";
import { openJsonc, parseJsonc, setValue } from "../jsonc.js";
import type { StepResult } from "../plan.js";
import { DEMO_FILES } from "../templates/demo.js";
import { templateFile } from "../templates/files.js";
import {
  gitignoreSkeleton,
  JSX_OPTIONS,
  packageSkeleton,
  type SkeletonInput,
  type Template,
  tsconfigSkeleton,
  wranglerSkeleton,
} from "../templates/standalone.js";

export interface StandaloneOptions extends SkeletonInput {
  files: Files;
}

/** The files a new Workers project needs before the shared upserts run; existing files are kept. */
export function ensureStandaloneSkeleton(options: StandaloneOptions): StepResult[] {
  const write = (file: string, content: string): StepResult => {
    const path = join(options.files.root, file);
    if (options.files.exists(path)) return { status: "skipped", file };
    return options.files.write(path, content);
  };
  const results = [
    write("package.json", packageSkeleton(options)),
    ensureTsconfig(options.files, options.template),
    write("wrangler.jsonc", wranglerSkeleton(options)),
    write(".gitignore", gitignoreSkeleton()),
  ];
  if (options.template === "demo")
    for (const [file, name] of Object.entries(DEMO_FILES))
      results.push(write(file, templateFile("demo", name)));
  return results;
}

interface TsConfig {
  compilerOptions?: Record<string, unknown>;
}

/**
 * A new tsconfig comes from the template. An existing one is kept, except that the demo
 * adds the two JSX options it lacks, preserving the rest of the file.
 */
function ensureTsconfig(files: Files, template: Template): StepResult {
  const file = "tsconfig.json";
  const path = join(files.root, file);
  const text = files.read(path);
  if (text === undefined) return files.write(path, tsconfigSkeleton(template));
  if (template !== "demo") return { status: "skipped", file };
  const current = parseJsonc<TsConfig>(text, file).compilerOptions ?? {};
  const missing = Object.entries(JSX_OPTIONS).filter(([key]) => !(key in current));
  if (missing.length === 0) return { status: "skipped", file };
  let document = openJsonc(text);
  for (const [key, value] of missing)
    document = setValue(document, ["compilerOptions", key], value);
  const kept = Object.entries(JSX_OPTIONS)
    .filter(([key, value]) => key in current && current[key] !== value)
    .map(([key, value]) => `${key} (the demo expects "${value}")`);
  return files.write(
    path,
    document.text,
    `${file} now sets ${missing.map(([key, value]) => `${key}: "${value}"`).join(" and ")} for hono/jsx${
      kept.length > 0 ? `; kept your ${kept.join(", ")}` : ""
    }.`,
  );
}
