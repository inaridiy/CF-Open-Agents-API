import type { Choice } from "../ui.js";
import { PROVIDER_VERSIONS } from "../versions.js";

export type Provider = "openai" | "anthropic" | "workers-ai" | "openai-compatible";
export type Harness = "codex" | "claude-code" | "opencode";

/**
 * The choices, with the labels the prompts show, are the list: `PROVIDERS` and `HARNESSES`
 * are derived from them so a new provider or runtime is added in one place and cannot be
 * offered interactively but rejected by `--provider`, or the reverse.
 */
export const PROVIDER_CHOICES = [
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
] as const satisfies readonly Choice<Provider>[];
export const PROVIDERS: readonly Provider[] = PROVIDER_CHOICES.map((choice) => choice.value);

export const HARNESS_CHOICES = [
  { value: "codex", label: "Codex" },
  { value: "claude-code", label: "Claude Code" },
  { value: "opencode", label: "OpenCode" },
] as const satisfies readonly Choice<Harness>[];
export const HARNESSES: readonly Harness[] = HARNESS_CHOICES.map((choice) => choice.value);

export interface CompositionInput {
  provider: Provider;
  harnesses: readonly Harness[];
  /** Adds the `workers` preset (Workers AI) next to another provider. */
  workersAi: boolean;
  /** `openai-compatible` only. */
  baseURL?: string;
  model?: string;
  /** A standalone Worker exports the API as its default export. */
  standalone: boolean;
}

const WIDTH = 100;
/**
 * The rendered file is compared with oxfmt's output, so every construct is written the way
 * the formatter would: on one line while it fits in `WIDTH`, wrapped otherwise. `indent` is
 * the indentation the caller adds afterwards.
 */
const fitted = (inline: string, wrapped: () => string[], indent = 0): string[] =>
  indent + inline.length <= WIDTH ? [inline] : wrapped();
/** The public preset name each runtime gets; clients send it as `agent.model`. */
export const PRESET_NAMES: Record<Harness, string> = {
  codex: "codex",
  "claude-code": "claude",
  opencode: "opencode",
};
/**
 * Catalog model ids the generated registry points at. Checked against the providers'
 * catalogs on 2026-09-19; the comments in the rendered file name the catalog pages.
 */
export const DEFAULT_MODELS = {
  openai: "gpt-6-astra",
  openaiFast: "gpt-5.6-luna",
  anthropicOpus: "claude-opus-5",
  anthropicSonnet: "claude-sonnet-5",
  anthropicHaiku: "claude-haiku-4-5-20251001",
  workers: "@cf/zai-org/glm-5.3-flash",
  workersQwen: "@cf/qwen/qwen3.8-27b",
} as const;

/** The secret the generated composition reads for the provider, if any. */
export function providerSecret(provider: Provider): string | undefined {
  switch (provider) {
    case "openai":
      return "OPENAI_API_KEY";
    case "anthropic":
      return "ANTHROPIC_API_KEY";
    case "openai-compatible":
      return "MODEL_API_KEY";
    default:
      return;
  }
}

type Tier = "haiku" | "sonnet" | "opus";
interface Preset {
  name: string;
  harness: Harness;
  model: string;
  /** Gateway names Claude Code's subagent tiers resolve to; a missing tier uses `model`. */
  tiers?: Partial<Record<Tier, string>>;
  webSearch: boolean;
}
interface ModelEntry {
  name: string;
  lines: string[];
}
interface Pieces {
  imports: Map<string, string[]>;
  helpers: Set<string>;
  bindings: Set<string>;
  models: ModelEntry[];
  presets: Preset[];
}

/** npm packages the composition imports, pinned like the workspace example. */
export function providerPackages(input: CompositionInput): Record<string, string> {
  const packages: Record<string, string> = {};
  for (const module of collect(input).imports.keys()) {
    if (module === "@ai-sdk/openai" || module === "workers-ai-provider") {
      packages["@ai-sdk/openai"] = PROVIDER_VERSIONS["@ai-sdk/openai"];
      packages["@ai-sdk/provider"] = PROVIDER_VERSIONS["@ai-sdk/provider"];
    }
    if (module === "@ai-sdk/anthropic") packages[module] = PROVIDER_VERSIONS["@ai-sdk/anthropic"];
    if (module === "workers-ai-provider")
      packages[module] = PROVIDER_VERSIONS["workers-ai-provider"];
  }
  return packages;
}

function nativeEntry(
  name: string,
  protocol: string,
  baseURL: string,
  secret: string,
  model: string,
): ModelEntry {
  return {
    name,
    lines: [
      `${name}: () =>`,
      "  nativeModel({",
      `    protocol: "${protocol}",`,
      `    baseURL: "${baseURL}",`,
      `    apiKey: env.${secret},`,
      `    model: "${model}",`,
      "  }),",
    ],
  };
}
function arrowEntry(name: string, expression: string, indent: number): ModelEntry {
  const lines = fitted(
    `${name}: () => ${expression},`,
    () => [`${name}: () =>`, `  ${expression},`],
    indent,
  );
  return { name, lines };
}

/** The portable pair every non-native harness uses: a primary model and a smaller, cheaper one. */
function portableEntries(
  pieces: Pieces,
  module: string,
  factory: string,
  secret: string,
  primary: string,
  fast: string,
): void {
  pieces.helpers.add("aiSDKModel");
  pieces.imports.set(module, [factory]);
  pieces.models.push(
    arrowEntry("primary", `aiSDKModel(${factory}({ apiKey: env.${secret} })("${primary}"))`, 6),
    arrowEntry("fast", `aiSDKModel(${factory}({ apiKey: env.${secret} })("${fast}"))`, 6),
  );
}
function portablePresets(pieces: Pieces, harnesses: readonly Harness[]): void {
  for (const harness of harnesses)
    pieces.presets.push({
      name: PRESET_NAMES[harness],
      harness,
      model: "primary",
      // The Agent tool's `model: "haiku"` picks the cheaper entry for a native subagent.
      ...(harness === "claude-code" ? { tiers: { haiku: "fast" } } : {}),
      webSearch: false,
    });
}

function openaiPieces(input: CompositionInput, pieces: Pieces): void {
  const secret = "OPENAI_API_KEY";
  pieces.bindings.add(`${secret}: string;`);
  const portable = input.harnesses.filter((harness) => harness !== "codex");
  if (input.harnesses.includes("codex")) {
    pieces.helpers.add("nativeModel");
    pieces.models.push(
      nativeEntry("codex", "responses", "https://api.openai.com/v1", secret, DEFAULT_MODELS.openai),
    );
    pieces.presets.push({ name: "codex", harness: "codex", model: "codex", webSearch: true });
  }
  if (portable.length > 0)
    portableEntries(
      pieces,
      "@ai-sdk/openai",
      "createOpenAI",
      secret,
      DEFAULT_MODELS.openai,
      DEFAULT_MODELS.openaiFast,
    );
  portablePresets(pieces, portable);
}

function anthropicPieces(input: CompositionInput, pieces: Pieces): void {
  const secret = "ANTHROPIC_API_KEY";
  pieces.bindings.add(`${secret}: string;`);
  const portable = input.harnesses.filter((harness) => harness !== "claude-code");
  if (input.harnesses.includes("claude-code")) {
    pieces.helpers.add("nativeModel");
    const native = (name: string, model: string) =>
      nativeEntry(name, "anthropic", "https://api.anthropic.com/v1", secret, model);
    pieces.models.push(
      native("opus", DEFAULT_MODELS.anthropicOpus),
      native("sonnet", DEFAULT_MODELS.anthropicSonnet),
      native("haiku", DEFAULT_MODELS.anthropicHaiku),
    );
    pieces.presets.push({
      name: "claude",
      harness: "claude-code",
      model: "opus",
      tiers: { haiku: "haiku", sonnet: "sonnet" },
      webSearch: true,
    });
  }
  if (portable.length > 0)
    portableEntries(
      pieces,
      "@ai-sdk/anthropic",
      "createAnthropic",
      secret,
      DEFAULT_MODELS.anthropicOpus,
      DEFAULT_MODELS.anthropicHaiku,
    );
  portablePresets(pieces, portable);
}

function workersEntries(pieces: Pieces): void {
  pieces.helpers.add("aiSDKModel");
  pieces.imports.set("workers-ai-provider", ["createWorkersAI"]);
  pieces.bindings.add("AI: Ai;");
  pieces.models.push(
    arrowEntry(
      "workers",
      `aiSDKModel(createWorkersAI({ binding: env.AI })("${DEFAULT_MODELS.workers}"))`,
      6,
    ),
    arrowEntry(
      "workersQwen",
      `aiSDKModel(createWorkersAI({ binding: env.AI })("${DEFAULT_MODELS.workersQwen}"))`,
      6,
    ),
  );
}

function workersAiPieces(input: CompositionInput, pieces: Pieces): void {
  workersEntries(pieces);
  for (const harness of input.harnesses)
    pieces.presets.push({
      name: PRESET_NAMES[harness],
      harness,
      model: "workers",
      webSearch: false,
    });
}

function compatiblePieces(input: CompositionInput, pieces: Pieces): void {
  const secret = "MODEL_API_KEY";
  pieces.bindings.add(`${secret}: string;`);
  pieces.helpers.add("openAICompatibleModel");
  pieces.models.push({
    name: "compatible",
    lines: [
      "compatible: () =>",
      "  openAICompatibleModel({",
      `    baseURL: "${input.baseURL ?? "https://example.com/v1"}",`,
      `    apiKey: env.${secret},`,
      `    model: "${input.model ?? "model"}",`,
      "  }),",
    ],
  });
  for (const harness of input.harnesses)
    pieces.presets.push({
      name: PRESET_NAMES[harness],
      harness,
      model: "compatible",
      webSearch: false,
    });
}

function collect(input: CompositionInput): Pieces {
  const pieces: Pieces = {
    imports: new Map(),
    helpers: new Set(),
    bindings: new Set(["API_TOKEN: string;"]),
    models: [],
    presets: [],
  };
  switch (input.provider) {
    case "openai":
      openaiPieces(input, pieces);
      break;
    case "anthropic":
      anthropicPieces(input, pieces);
      break;
    case "workers-ai":
      workersAiPieces(input, pieces);
      break;
    default:
      compatiblePieces(input, pieces);
  }
  if (input.workersAi && input.provider !== "workers-ai") {
    workersEntries(pieces);
    const harness = input.harnesses.includes("codex") ? "codex" : (input.harnesses[0] ?? "codex");
    pieces.presets.push({ name: "workers", harness, model: "workers", webSearch: false });
  }
  return pieces;
}

/** The preset names a composition defines, in rendering order. */
function presetNames(input: CompositionInput): string[] {
  return collect(input).presets.map((preset) => preset.name);
}

/** The provider secret with a `.dev.vars` comment naming the presets that need it. */
export function describeSecret(
  input: CompositionInput,
): { name: string; comment: string } | undefined {
  const name = providerSecret(input.provider);
  if (!name) return;
  const presets = presetNames(input);
  const needing = presets.filter((preset) => preset !== "workers");
  const free = presets.filter((preset) => preset === "workers");
  const list =
    needing.length > 1 ? `${needing.slice(0, -1).join(", ")} and ${needing.at(-1)}` : needing[0];
  const plural = needing.length > 1 ? "presets" : "preset";
  const tail =
    free.length > 0
      ? `; leave empty to use only ${free.map((preset) => `\`${preset}\``).join(", ")}.`
      : ".";
  return { name, comment: `# Required for the ${list} ${plural}${tail}` };
}

const quoted = (values: readonly string[]) => values.map((value) => `"${value}"`).join(", ");

function presetLines(preset: Preset, presets: readonly Preset[]): string[] {
  const delegates = presets
    .filter((other) => other !== preset && other.name !== "workers")
    .map((other) => other.name);
  const fields = [`harness: "${preset.harness}"`, `model: "${preset.model}"`];
  if (preset.tiers)
    fields.push(
      `tiers: { ${Object.entries(preset.tiers)
        .map(([tier, model]) => `${tier}: "${model}"`)
        .join(", ")} }`,
    );
  if (preset.name !== "workers" && delegates.length > 0)
    fields.push(`delegates: [${quoted(delegates)}]`);
  if (preset.webSearch) fields.push("webSearch: true");
  return fitted(`      ${preset.name}: { ${fields.join(", ")} },`, () => [
    `      ${preset.name}: {`,
    ...fields.map((field) => `        ${field},`),
    "      },",
  ]);
}

const sortedNames = (names: Iterable<string>) =>
  [...names].sort((a, b) => a.replace(/^type /, "").localeCompare(b.replace(/^type /, ""), "en"));

function importLines(pieces: Pieces): string[] {
  const modules = new Map<string, string[]>(pieces.imports);
  modules.set("cf-open-agents-api/cloudflare", [
    "type AgentBindings",
    "bearerTenant",
    "type ContainerBindings",
    "defineAgentWorker",
  ]);
  modules.set("cf-open-agents-api/models", sortedNames(pieces.helpers));
  return [...modules.keys()]
    .sort((a, b) => a.localeCompare(b, "en"))
    .flatMap((module) => {
      const names = sortedNames(modules.get(module) ?? []);
      return fitted(`import { ${names.join(", ")} } from "${module}";`, () => [
        "import {",
        ...names.map((name) => `  ${name},`),
        `} from "${module}";`,
      ]);
    });
}

/** Renders the composition module; the standalone form is byte-identical to examples/worker/src/index.ts. */
export function renderComposition(input: CompositionInput): string {
  const pieces = collect(input);
  const lines = [
    ...importLines(pieces),
    "",
    "// Wrangler bindings the composition reads: the library's Durable Objects, buckets and",
    "// gateway (AgentBindings, ContainerBindings), plus the secrets and bindings named here.",
    "// Secrets come from .dev.vars locally and from `wrangler secret put` in production.",
    "interface Bindings extends AgentBindings, ContainerBindings {",
    ...sortedNames(pieces.bindings).map((binding) => `  ${binding}`),
    "}",
    "",
    "// Wrangler binds the Durable Objects by these export names and the private model",
    "// gateway by the `Models` entrypoint; keep them as they are.",
    "export const { Agents, Models, SessionDO, TenantCatalogDO, HarnessDO, SandboxDO, ContainerProxy } =",
    "  defineAgentWorker<Bindings>({",
    "    // Presets: the `agent.model` names clients send. Each maps to a native runtime",
    "    // (`harness`) and a gateway registry name (`model`). Optional fields: `delegates` lists",
    "    // the presets a session may start subagents on when multi_agent is enabled (children",
    "    // share the parent's sandbox); `tiers` names the registry entries Claude Code's",
    "    // haiku/sonnet/opus subagent tiers resolve to; `webSearch` declares that the model",
    "    // connection provides hosted web search (a nativeModel connection, not the AI SDK path).",
    "    agents: {",
    ...pieces.presets.flatMap((preset) => presetLines(preset, pieces.presets)),
    "    },",
    "    // The private model gateway. Keys are deployment-owned names that presets point at;",
    "    // runtimes never see provider URLs or keys. Each entry is a factory built only when a",
    "    // session selects it, so a deployment without one provider's credentials still serves",
    "    // the other presets. Add a model here, then point a preset's `model` at it.",
    "    models: (env) => ({",
    ...pieces.models.flatMap((entry) => entry.lines.map((line) => `      ${line}`)),
    "    }),",
    "    // Who may call the API. `bearerTenant` accepts one shared bearer token (API_TOKEN, at",
    '    // least 32 characters) and maps every caller to the tenant "default"; Service Binding',
    "    // callers pass the same token. Replace it to resolve tenants from your own auth.",
    '    authenticate: (request, env) => bearerTenant(request, env.API_TOKEN, "default"),',
    "  });",
  ];
  if (input.standalone) lines.push("export default Agents;");
  return `${lines.join("\n")}\n`;
}
