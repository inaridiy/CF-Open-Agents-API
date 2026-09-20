import type { Project } from "./project.js";
import { workerNameFrom } from "./project.js";
import { type Harness, HARNESSES, type Provider, PROVIDERS } from "./templates/agents.js";
import { type Template, TEMPLATES } from "./templates/standalone.js";
import type { Prompter } from "./ui.js";

/** Flags that pre-answer questions; anything missing is asked or defaulted. */
export interface InitPreferences {
  name?: string;
  /** New projects only. */
  template?: Template;
  provider?: Provider;
  baseURL?: string;
  model?: string;
  harnesses?: readonly Harness[];
  workersAi?: boolean;
  codeLoader?: boolean;
  /** Add the `dev:rootless` script; `undefined` asks when rootless Docker is detected. */
  rootless?: boolean;
  install?: boolean;
}

export interface InitAnswers {
  name: string;
  template: Template;
  provider: Provider;
  baseURL?: string;
  model?: string;
  harnesses: Harness[];
  workersAi: boolean;
  codeLoader: boolean;
  rootless: boolean;
  install: boolean;
}

/** What the CLI found out about the machine before asking. */
export interface Detected {
  rootlessDocker: boolean;
}

const TEMPLATE_CHOICES = [
  {
    value: "demo",
    label: "Demo app",
    hint: "Hono page: type a prompt, watch the agent build in a sandbox, download the files",
  },
  {
    value: "minimal",
    label: "Minimal API Worker",
    hint: "the Agents API alone, reached with the OpenAI client or a Service Binding",
  },
] as const satisfies readonly { value: Template; label: string; hint: string }[];
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
export function parseTemplate(value: string): Template {
  if ((TEMPLATES as readonly string[]).includes(value)) return value as Template;
  throw new Error(`Unknown template ${value}; expected one of ${TEMPLATES.join(", ")}`);
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
  detected: Detected = { rootlessDocker: false },
): Promise<InitAnswers> {
  const name =
    preferences.name ??
    configName ??
    (await prompter.text("Worker name", workerNameFrom(project.root)));
  const template =
    project.mode === "standalone"
      ? (preferences.template ??
        (await prompter.select("Project template", TEMPLATE_CHOICES, "demo")))
      : "minimal";
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
  const rootless =
    preferences.rootless ??
    (detected.rootlessDocker
      ? await prompter.confirm(
          "Docker runs rootless here, where plain `wrangler dev` cannot complete a turn. Add a dev:rootless script that runs it inside rootlesskit's network namespace? (A temporary workaround for Wrangler's local container proxy assuming a rootful bridge, to be removed when Wrangler supports rootless engines)",
          true,
        )
      : false);
  const install =
    preferences.install ?? (await prompter.confirm("Install dependencies now?", false));
  return {
    name,
    template,
    provider,
    ...compatible,
    harnesses: harnesses.length > 0 ? [...harnesses] : [...HARNESSES],
    workersAi,
    codeLoader,
    rootless,
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
