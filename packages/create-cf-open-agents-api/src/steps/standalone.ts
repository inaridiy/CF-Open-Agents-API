import { join } from "node:path";

import type { Files } from "../fs.js";
import type { StepResult } from "../plan.js";
import {
  gitignoreSkeleton,
  packageSkeleton,
  type SkeletonInput,
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
  return [
    write("package.json", packageSkeleton(options)),
    write("tsconfig.json", tsconfigSkeleton()),
    write("wrangler.jsonc", wranglerSkeleton(options)),
    write(".gitignore", gitignoreSkeleton()),
  ];
}
