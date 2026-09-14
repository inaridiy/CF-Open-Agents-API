import { WorkerEntrypoint } from "cloudflare:workers";
import { createOpenAI } from "@ai-sdk/openai";
import {
  type AgentBindings,
  bearerTenant,
  CatalogObject,
  type ContainerBindings,
  ContainerProxy,
  containerEnvironments,
  containerHarnesses,
  createAgentService,
  HarnessContainer,
  SandboxContainer,
} from "cf-open-agents-api/cloudflare";
import { aiSDKModel, createModelGateway, nativeModel } from "cf-open-agents-api/models";
import { createWorkersAI } from "workers-ai-provider";

interface Bindings extends AgentBindings, ContainerBindings {
  AI: Ai;
  API_TOKEN: string;
  OPENAI_API_KEY: string;
}
const service = createAgentService<Bindings>({
  agents: {
    // `delegates` lists the presets a session may start subagents on when
    // multi_agent is enabled; children share the parent's sandbox.
    coding: { harness: "codex", model: "codex", delegates: ["claude", "opencode"] },
    claude: { harness: "claude-code", model: "primary", delegates: ["coding", "opencode"] },
    opencode: { harness: "opencode", model: "primary", delegates: ["coding", "claude"] },
    workers: { harness: "codex", model: "workers" },
  },
  harnesses: containerHarnesses,
  objects: (env) => env.CHECKPOINTS,
  environments: containerEnvironments,
  authenticate: (request, env) => bearerTenant(request, env.API_TOKEN, "default"),
});

const gateway = createModelGateway<Bindings>((env) => ({
  codex: nativeModel({
    protocol: "responses",
    baseURL: "https://api.openai.com/v1",
    apiKey: env.OPENAI_API_KEY,
    model: "gpt-6-astra",
  }),
  primary: aiSDKModel(createOpenAI({ apiKey: env.OPENAI_API_KEY })("gpt-6-astra")),
  workers: aiSDKModel(createWorkersAI({ binding: env.AI })("@cf/zai-org/glm-4.7-flash")),
}));

export class SessionDO extends service.SessionDO {}
export class TenantCatalogDO extends CatalogObject {}
export { HarnessContainer as HarnessDO };
export class SandboxDO extends SandboxContainer {}
export { ContainerProxy };
export default class AgentWorker extends service.AgentWorker {}

/** Private Service Binding: model instances and provider credentials stay in Workers. */
export class Models extends WorkerEntrypoint<Bindings> {
  override fetch(request: Request): Promise<Response> {
    return gateway.fetch(request, this.env);
  }
}
