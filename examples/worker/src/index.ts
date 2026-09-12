import { WorkerEntrypoint } from "cloudflare:workers";
import { createOpenAI } from "@ai-sdk/openai";
import {
  type AgentBindings,
  bearerTenant,
  CatalogObject,
  type ContainerBindings,
  ContainerProxy,
  containerHarnesses,
  createAgentService,
  HarnessContainer,
  SandboxContainer,
} from "cf-open-agents-api/cloudflare";
import { aiSDKModel, createModelGateway } from "cf-open-agents-api/models";
import { createWorkersAI } from "workers-ai-provider";

interface Bindings extends AgentBindings, ContainerBindings {
  AI: Ai;
  API_TOKEN: string;
  OPENAI_API_KEY: string;
}
const service = createAgentService<Bindings>({
  agents: {
    coding: { harness: "codex", model: "primary" },
    claude: { harness: "claude-code", model: "primary" },
    opencode: { harness: "opencode", model: "primary" },
    workers: { harness: "codex", model: "workers" },
  },
  harnesses: containerHarnesses,
  authenticate: (request, env) => bearerTenant(request, env.API_TOKEN, "default"),
});

const gateway = createModelGateway<Bindings>((env) => ({
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
