import type { Files } from "../fs.js";
import type { StepResult } from "../plan.js";
import { type CompositionInput, renderComposition } from "../templates/agents.js";

/** Writes the composition module; an edited file is kept unless `--force`. */
export function ensureAgentsFile(
  files: Files,
  path: string,
  composition: CompositionInput,
  force: boolean,
): StepResult {
  const content = renderComposition(composition);
  const existing = files.read(path);
  if (existing !== undefined && existing !== content && !force) {
    const file = path
      .slice(files.root.length + 1)
      .split("\\")
      .join("/");
    return {
      status: "skipped",
      file,
      note: `${file} exists with different content and was kept; --force rewrites it from the template.`,
    };
  }
  return files.write(path, content);
}
