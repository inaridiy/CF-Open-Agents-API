import type { CompositionRecord } from "../composition-record.js";
import { type Files, keepUnlessForce } from "../fs.js";
import type { StepResult } from "../plan.js";
import { type CompositionInput, renderComposition } from "../templates/agents.js";

export interface AgentsFile {
  result: StepResult;
  /**
   * The composition the project actually has: what this run rendered when it wrote the
   * module, and what `recorded` says when the module on disk was kept instead. `undefined`
   * means a kept module belongs to neither — no record and no markers to read it by — and
   * the caller must then derive nothing from the answers, because nothing would confirm it.
   */
  composition: CompositionInput | undefined;
  /** Whether the module on disk was kept rather than written. */
  kept: boolean;
}

const UNATTRIBUTED =
  "It matches no composition record and names no provider this CLI recognizes, so nothing was derived from the answers: no provider dependency, no provider key, no Workers AI binding and no composition record. The module decides them.";

/** Writes the composition module; an edited file is kept unless `--force`. */
export function ensureAgentsFile(
  files: Files,
  path: string,
  composition: CompositionInput,
  recorded: CompositionRecord | undefined,
  force: boolean,
): AgentsFile {
  const content = renderComposition(composition);
  const kept = keepUnlessForce(files, path, content, force);
  if (!kept) return { result: files.write(path, content), composition, kept: false };
  const attributed = recorded ? { ...recorded, standalone: composition.standalone } : undefined;
  return {
    result: {
      ...kept,
      note: `${kept.note} ${attributed ? "Its provider and runtimes still decide the dependencies and the secrets." : UNATTRIBUTED}`,
    },
    composition: attributed,
    kept: true,
  };
}
