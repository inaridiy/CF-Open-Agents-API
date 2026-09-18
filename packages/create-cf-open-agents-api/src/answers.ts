import type { Project } from "./project.js";
import { workerNameFrom } from "./project.js";
import { type Harness, HARNESSES, type Provider, PROVIDERS } from "./templates/agents.js";
import type { Prompter } from "./ui.js";

/** Flags that pre-answer questions; anything missing is asked or defaulted. */
export interface InitPreferences {
  name?: string;
  provider?: Provider;
  baseURL?: string;
  model?: string;
  harnesses?: readonly Harness[];
  workersAi?: boolean;
  codeLoader?: boolean;
  publicRoute?: boolean;
  install?: boolean;
}

export interface InitAnswers {
  name: string;
  provider: Provider;
  baseURL?: string;
  model?: string;
  harnesses: Harness[];
  workersAi: boolean;
  codeLoader: boolean;
  publicRoute: boolean;
  install: boolean;
}

const PROVIDER_CHOICES = [
  {
    value: "openai",
    label: "OpenAI",
    hint: "Codex natively, Claude Code and OpenCode through the AI SDK",
  },
  {
    value: "anthropic",
    label: "Anthropic",
    hint: "Claude Code natively, Codex and OpenCode through the AI SDK",
  },
  {
    value: "workers-ai",
    label: "Workers AI",
    hint: "no provider key; billed to your Cloudflare account",
  },
  {
    value: "openai-compatible",
    label: "OpenAI-compatible endpoint",
    hint: "any Chat Completions URL",
  },
] as const satisfies readonly { value: Provider; label: string; hint: string }[];
const HARNESS_CHOICES = [
  { value: "codex", label: "Codex" },
  { value: "claude-code", label: "Claude Code" },
  { value: "opencode", label: "OpenCode" },
] as const satisfies readonly { value: Harness; label: string }[];

export function parseProvider(value: string): Provider {
  if ((PROVIDERS as readonly string[]).includes(value)) return value as Provider;
  throw new Error(`Unknown provider ${value}; expected one of ${PROVIDERS.join(", ")}`);
}
export function parseHarnesses(value: string): Harness[] {
  const names = value
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  const unknown = names.find((name) => !(HARNESSES as readonly string[]).includes(name));
  if (unknown) throw new Error(`Unknown harness ${unknown}; expected ${HARNESSES.join(", ")}`);
  return HARNESSES.filter((harness) => names.includes(harness));
}

/** Asks what the flags left open, in the order a first-time user needs. */
export async function collectAnswers(
  project: Project,
  configName: string | undefined,
  preferences: InitPreferences,
  prompter: Prompter,
): Promise<InitAnswers> {
  const name =
    preferences.name ??
    configName ??
    (await prompter.text("Worker name", workerNameFrom(project.root)));
  const provider =
    preferences.provider ?? (await prompter.select("Model provider", PROVIDER_CHOICES, "openai"));
  const compatible =
    provider === "openai-compatible" ? await compatibleAnswers(preferences, prompter) : {};
  const harnesses =
    preferences.harnesses ??
    (await prompter.multiselect(
      "Native runtimes to expose as presets",
      HARNESS_CHOICES,
      HARNESSES,
    ));
  const workersAi =
    provider === "workers-ai"
      ? false
      : (preferences.workersAi ??
        (await prompter.confirm(
          "Also add a Workers AI preset (no provider key, billed to Cloudflare)?",
          false,
        )));
  const codeLoader =
    preferences.codeLoader ??
    (await prompter.confirm("Enable programmatic tool calling (Dynamic Workers)?", true));
  const publicRoute =
    project.mode === "standalone"
      ? (preferences.publicRoute ??
        (await prompter.confirm(
          "Expose the HTTP API on workers.dev? (No = Service Binding only)",
          false,
        )))
      : false;
  const install =
    preferences.install ?? (await prompter.confirm("Install dependencies now?", false));
  return {
    name,
    provider,
    ...compatible,
    harnesses: harnesses.length > 0 ? [...harnesses] : [...HARNESSES],
    workersAi,
    codeLoader,
    publicRoute,
    install,
  };
}

async function compatibleAnswers(
  preferences: InitPreferences,
  prompter: Prompter,
): Promise<{ baseURL: string; model: string }> {
  return {
    baseURL:
      preferences.baseURL ??
      (await prompter.text("Chat Completions base URL", "https://api.example.com/v1")),
    model: preferences.model ?? (await prompter.text("Model id", "model")),
  };
}
