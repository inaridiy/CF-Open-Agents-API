import { createOpenAI } from "@ai-sdk/openai";
import {
  type AgentBindings,
  bearerTenant,
  type ContainerBindings,
  defineAgentWorker,
} from "cf-open-agents-api/cloudflare";
import { aiSDKModel, nativeModel } from "cf-open-agents-api/models";
import { createWorkersAI } from "workers-ai-provider";

// Wrangler bindings the composition reads: the library's Durable Objects, buckets and
// gateway (AgentBindings, ContainerBindings), plus the secrets and bindings named here.
// Secrets come from .dev.vars locally and from `wrangler secret put` in production.
interface Bindings extends AgentBindings, ContainerBindings {
  AI: Ai;
  API_TOKEN: string;
  OPENAI_API_KEY: string;
}

// Wrangler binds the Durable Objects by these export names and the private model
// gateway by the `Models` entrypoint; keep them as they are.
export const { Agents, Models, SessionDO, TenantCatalogDO, HarnessDO, SandboxDO, ContainerProxy } =
  defineAgentWorker<Bindings>({
    // Presets: the `agent.model` names clients send. Each maps to a native runtime
    // (`harness`) and a gateway registry name (`model`). Optional fields: `delegates` lists
    // the presets a session may start subagents on when multi_agent is enabled (children
    // share the parent's sandbox); `tiers` names the registry entries Claude Code's
    // haiku/sonnet/opus subagent tiers resolve to; `webSearch` declares that the model
    // connection provides hosted web search (a nativeModel connection, not the AI SDK path).
    agents: {
      codex: {
        harness: "codex",
        model: "codex",
        delegates: ["claude", "opencode"],
        webSearch: true,
      },
      claude: {
        harness: "claude-code",
        model: "primary",
        tiers: { haiku: "fast" },
        delegates: ["codex", "opencode"],
      },
      opencode: { harness: "opencode", model: "primary", delegates: ["codex", "claude"] },
      workers: { harness: "codex", model: "workers" },
    },
    // The private model gateway. Keys are deployment-owned names that presets point at;
    // runtimes never see provider URLs or keys. Each entry is a factory built only when a
    // session selects it, so a deployment without one provider's credentials still serves
    // the other presets. Add a model here, then point a preset's `model` at it.
    models: (env) => ({
      codex: () =>
        nativeModel({
          protocol: "responses",
          baseURL: "https://api.openai.com/v1",
          apiKey: env.OPENAI_API_KEY,
          model: "gpt-6-astra",
        }),
      primary: () => aiSDKModel(createOpenAI({ apiKey: env.OPENAI_API_KEY })("gpt-6-astra")),
      fast: () => aiSDKModel(createOpenAI({ apiKey: env.OPENAI_API_KEY })("gpt-5.6-luna")),
      workers: () => aiSDKModel(createWorkersAI({ binding: env.AI })("@cf/zai-org/glm-5.3-flash")),
      workersQwen: () => aiSDKModel(createWorkersAI({ binding: env.AI })("@cf/qwen/qwen3.8-27b")),
    }),
    // Who may call the API. `bearerTenant` accepts one shared bearer token (API_TOKEN, at
    // least 32 characters) and maps every caller to the tenant "default"; Service Binding
    // callers pass the same token. Replace it to resolve tenants from your own auth.
    authenticate: (request, env) => bearerTenant(request, env.API_TOKEN, "default"),
  });
export default Agents;
