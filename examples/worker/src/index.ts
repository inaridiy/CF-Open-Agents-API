import { createOpenAI } from "@ai-sdk/openai";
import {
  type AgentBindings,
  bearerTenant,
  type ContainerBindings,
  defineAgentWorker,
} from "cf-open-agents-api/cloudflare";
import { aiSDKModel, nativeModel } from "cf-open-agents-api/models";
import { createWorkersAI } from "workers-ai-provider";

interface Bindings extends AgentBindings, ContainerBindings {
  AI: Ai;
  API_TOKEN: string;
  OPENAI_API_KEY: string;
}

// Wrangler binds the Durable Objects by these export names and the private model
// gateway by the `Models` entrypoint; keep them as they are.
export const { Agents, Models, SessionDO, TenantCatalogDO, HarnessDO, SandboxDO, ContainerProxy } =
  defineAgentWorker<Bindings>({
    // `delegates` lists the presets a session may start subagents on when
    // multi_agent is enabled; children share the parent's sandbox.
    // `webSearch` declares that the alias's model connection provides hosted web search.
    agents: {
      coding: {
        harness: "codex",
        model: "codex",
        delegates: ["claude", "opencode"],
        webSearch: true,
      },
      claude: { harness: "claude-code", model: "primary", delegates: ["coding", "opencode"] },
      opencode: { harness: "opencode", model: "primary", delegates: ["coding", "claude"] },
      workers: { harness: "codex", model: "workers" },
    },
    // Each entry is a factory: a preset is built only when a session selects it, so a
    // deployment without an OpenAI key can still serve the Workers AI preset.
    models: (env) => ({
      codex: () =>
        nativeModel({
          protocol: "responses",
          baseURL: "https://api.openai.com/v1",
          apiKey: env.OPENAI_API_KEY,
          model: "gpt-6-astra",
        }),
      primary: () => aiSDKModel(createOpenAI({ apiKey: env.OPENAI_API_KEY })("gpt-6-astra")),
      workers: () => aiSDKModel(createWorkersAI({ binding: env.AI })("@cf/zai-org/glm-4.7-flash")),
    }),
    authenticate: (request, env) => bearerTenant(request, env.API_TOKEN, "default"),
  });
export default Agents;
