import { PROVIDER_VERSIONS } from "../versions.js";

export type Provider = "openai" | "anthropic" | "workers-ai" | "openai-compatible";
export const PROVIDERS: readonly Provider[] = [
  "openai",
  "anthropic",
  "workers-ai",
  "openai-compatible",
];
export type Harness = "codex" | "claude-code" | "opencode";
export const HARNESSES: readonly Harness[] = ["codex", "claude-code", "opencode"];

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
export const PRESET_NAMES: Record<Harness, string> = {
  codex: "coding",
  "claude-code": "claude",
  opencode: "opencode",
};
const DEFAULT_MODELS = {
  openai: "gpt-6-astra",
  anthropic: "claude-opus-5",
  "workers-ai": "@cf/zai-org/glm-4.7-flash",
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

interface Preset {
  name: string;
  harness: Harness;
  model: string;
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
  const inline = `${name}: () => ${expression},`;
  const lines = indent + inline.length <= WIDTH ? [inline] : [`${name}: () =>`, `  ${expression},`];
  return { name, lines };
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
    pieces.presets.push({ name: "coding", harness: "codex", model: "codex", webSearch: true });
  }
  if (portable.length > 0) {
    pieces.helpers.add("aiSDKModel");
    pieces.imports.set("@ai-sdk/openai", ["createOpenAI"]);
    pieces.models.push(
      arrowEntry(
        "primary",
        `aiSDKModel(createOpenAI({ apiKey: env.${secret} })("${DEFAULT_MODELS.openai}"))`,
        6,
      ),
    );
  }
  for (const harness of portable)
    pieces.presets.push({
      name: PRESET_NAMES[harness],
      harness,
      model: "primary",
      webSearch: false,
    });
}

function anthropicPieces(input: CompositionInput, pieces: Pieces): void {
  const secret = "ANTHROPIC_API_KEY";
  pieces.bindings.add(`${secret}: string;`);
  const portable = input.harnesses.filter((harness) => harness !== "claude-code");
  if (input.harnesses.includes("claude-code")) {
    pieces.helpers.add("nativeModel");
    pieces.models.push(
      nativeEntry(
        "claude",
        "anthropic",
        "https://api.anthropic.com/v1",
        secret,
        DEFAULT_MODELS.anthropic,
      ),
    );
    pieces.presets.push({
      name: "claude",
      harness: "claude-code",
      model: "claude",
      webSearch: true,
    });
  }
  if (portable.length > 0) {
    pieces.helpers.add("aiSDKModel");
    pieces.imports.set("@ai-sdk/anthropic", ["createAnthropic"]);
    pieces.models.push(
      arrowEntry(
        "primary",
        `aiSDKModel(createAnthropic({ apiKey: env.${secret} })("${DEFAULT_MODELS.anthropic}"))`,
        6,
      ),
    );
  }
  for (const harness of portable)
    pieces.presets.push({
      name: PRESET_NAMES[harness],
      harness,
      model: "primary",
      webSearch: false,
    });
}

function workersEntry(pieces: Pieces): void {
  pieces.helpers.add("aiSDKModel");
  pieces.imports.set("workers-ai-provider", ["createWorkersAI"]);
  pieces.bindings.add("AI: Ai;");
  pieces.models.push(
    arrowEntry(
      "workers",
      `aiSDKModel(createWorkersAI({ binding: env.AI })("${DEFAULT_MODELS["workers-ai"]}"))`,
      6,
    ),
  );
}

function workersAiPieces(input: CompositionInput, pieces: Pieces): void {
  workersEntry(pieces);
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
    workersEntry(pieces);
    const harness = input.harnesses.includes("codex") ? "codex" : (input.harnesses[0] ?? "codex");
    pieces.presets.push({ name: "workers", harness, model: "workers", webSearch: false });
  }
  return pieces;
}

/** The provider secret with a `.dev.vars` comment naming the presets that need it. */
export function describeSecret(
  input: CompositionInput,
): { name: string; comment: string } | undefined {
  const name = providerSecret(input.provider);
  if (!name) return;
  const presets = collect(input).presets.map((preset) => preset.name);
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
  if (preset.name !== "workers" && delegates.length > 0)
    fields.push(`delegates: [${quoted(delegates)}]`);
  if (preset.webSearch) fields.push("webSearch: true");
  const inline = `      ${preset.name}: { ${fields.join(", ")} },`;
  if (inline.length <= WIDTH) return [inline];
  return [`      ${preset.name}: {`, ...fields.map((field) => `        ${field},`), "      },"];
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
      const inline = `import { ${names.join(", ")} } from "${module}";`;
      if (inline.length <= WIDTH) return [inline];
      return ["import {", ...names.map((name) => `  ${name},`), `} from "${module}";`];
    });
}

/** Renders the composition module; the standalone form is byte-identical to examples/worker/src/index.ts. */
export function renderComposition(input: CompositionInput): string {
  const pieces = collect(input);
  const lines = [
    ...importLines(pieces),
    "",
    "interface Bindings extends AgentBindings, ContainerBindings {",
    ...sortedNames(pieces.bindings).map((binding) => `  ${binding}`),
    "}",
    "",
    "// Wrangler binds the Durable Objects by these export names and the private model",
    "// gateway by the `Models` entrypoint; keep them as they are.",
    "export const { Agents, Models, SessionDO, TenantCatalogDO, HarnessDO, SandboxDO, ContainerProxy } =",
    "  defineAgentWorker<Bindings>({",
    "    // `delegates` lists the presets a session may start subagents on when",
    "    // multi_agent is enabled; children share the parent's sandbox.",
    "    // `webSearch` declares that the alias's model connection provides hosted web search.",
    "    agents: {",
    ...pieces.presets.flatMap((preset) => presetLines(preset, pieces.presets)),
    "    },",
    "    // Each entry is a factory: a preset is built only when a session selects it, so a",
    "    // deployment without one provider's credentials can still serve the other presets.",
    "    models: (env) => ({",
    ...pieces.models.flatMap((entry) => entry.lines.map((line) => `      ${line}`)),
    "    }),",
    '    authenticate: (request, env) => bearerTenant(request, env.API_TOKEN, "default"),',
    "  });",
  ];
  if (input.standalone) lines.push("export default Agents;");
  return `${lines.join("\n")}\n`;
}
