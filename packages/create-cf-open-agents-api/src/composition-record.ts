import { join } from "node:path";

import { type Files, readIfExists } from "./fs.js";
import type { StepResult } from "./plan.js";
import {
  type CompositionInput,
  type Harness,
  HARNESSES,
  type Provider,
  PROVIDERS,
  providerSecret,
} from "./templates/agents.js";
import { VENDOR_DIRECTORY } from "./versions.js";

/**
 * What the composition module was generated from. A second `init` keeps an existing
 * composition, so everything derived from it — the provider packages in `package.json`, the
 * secret in `.dev.vars` and the secrets `setup` asks for — must follow the record instead of
 * the answers a fresh run would default to. It is generated, machine-owned and git-ignored,
 * so it lives next to the image snapshot rather than in the project's own files.
 */
export interface CompositionRecord {
  provider: Provider;
  harnesses: Harness[];
  workersAi: boolean;
  baseURL?: string;
  model?: string;
}

export const RECORD_FILE = `${VENDOR_DIRECTORY}/composition.json`;

export const recordPath = (root: string): string => join(root, RECORD_FILE);

const record = (input: CompositionInput): CompositionRecord => ({
  provider: input.provider,
  harnesses: [...input.harnesses],
  workersAi: input.workersAi,
  ...(input.baseURL === undefined ? {} : { baseURL: input.baseURL }),
  ...(input.model === undefined ? {} : { model: input.model }),
});

/** Records what the composition was generated from; unchanged on a re-run. */
export function ensureCompositionRecord(files: Files, composition: CompositionInput): StepResult {
  return files.write(recordPath(files.root), `${JSON.stringify(record(composition), null, 2)}\n`);
}

/** A record written by this or an earlier run; anything unrecognizable is no record at all. */
export function parseCompositionRecord(text: string | undefined): CompositionRecord | undefined {
  if (!text) return;
  let value: Partial<CompositionRecord>;
  try {
    value = JSON.parse(text) as Partial<CompositionRecord>;
  } catch {
    return;
  }
  if (!PROVIDERS.includes(value.provider as Provider)) return;
  // A record naming no runtime this CLI knows says nothing about the composition; guessing
  // all three here would hand `init` and `setup` a provider and secrets nobody chose.
  const harnesses = HARNESSES.filter((harness) => value.harnesses?.includes(harness));
  if (harnesses.length === 0) return;
  return {
    provider: value.provider as Provider,
    harnesses,
    workersAi: value.workersAi === true,
    ...(typeof value.baseURL === "string" ? { baseURL: value.baseURL } : {}),
    ...(typeof value.model === "string" ? { model: value.model } : {}),
  };
}

export const readCompositionRecord = (root: string): CompositionRecord | undefined =>
  parseCompositionRecord(readIfExists(recordPath(root)));

const SECRET_PROVIDERS: readonly (readonly [string, Provider])[] = PROVIDERS.flatMap((provider) => {
  const secret = providerSecret(provider);
  return secret ? [[secret, provider] as const] : [];
});

/**
 * The composition of a module written before the record existed, or edited by hand. The
 * generated file names exactly one provider secret (or none, for Workers AI) and one
 * `harness:` per preset, which is enough to keep the dependencies and secrets matching it.
 * This reads those markers; it does not parse TypeScript, and an unrecognizable file simply
 * has no inferred composition.
 */
export function inferCompositionRecord(source: string | undefined): CompositionRecord | undefined {
  if (!source?.includes("defineAgentWorker")) return;
  const workersAI = source.includes("createWorkersAI(");
  const found = SECRET_PROVIDERS.find(([secret]) => source.includes(`env.${secret}`));
  const provider = found?.[1] ?? (workersAI ? "workers-ai" : undefined);
  if (!provider) return;
  const harnesses = HARNESSES.filter((harness) => source.includes(`harness: "${harness}"`));
  if (harnesses.length === 0) return;
  const compatible =
    /baseURL: "([^"]*)",\r?\n\s*apiKey: env\.MODEL_API_KEY,\r?\n\s*model: "([^"]*)"/.exec(source);
  return {
    provider,
    harnesses,
    workersAi: workersAI && provider !== "workers-ai",
    ...(compatible?.[1] === undefined ? {} : { baseURL: compatible[1], model: compatible[2] }),
  };
}
