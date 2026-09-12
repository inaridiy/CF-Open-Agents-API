import { WorkerEntrypoint } from "cloudflare:workers";
import { type AIHarnessBindings, aiSDKDriver, createAIHarness } from "cf-open-agents-api/ai-sdk";
import {
  type AgentBindings,
  bearerTenant,
  CatalogObject,
  type ContainerBindings,
  ContainerProxy,
  codexDriver,
  createAgentService,
  HarnessContainer,
  SandboxContainer,
} from "cf-open-agents-api/cloudflare";
import { createWorkersAI } from "workers-ai-provider";

interface Bindings extends AgentBindings, ContainerBindings, AIHarnessBindings {
  AI: Ai;
  API_TOKEN: string;
  OPENAI_API_KEY: string;
}
const service = createAgentService<Bindings>({
  // The public alias is stable even when a deployment changes its upstream model.
  models: {
    coding: { driver: "codex", model: "gpt-5.4" },
    assistant: { driver: "ai-sdk", model: "@cf/zai-org/glm-4.7-flash" },
  },
  drivers: (env) => ({ codex: codexDriver(env), "ai-sdk": aiSDKDriver(env) }),
  authenticate: (request, env) => bearerTenant(request, env.API_TOKEN, "default"),
});

const AIHarness = createAIHarness<Bindings>((env, model) =>
  createWorkersAI({ binding: env.AI })(model),
);
export class AIHarnessDO extends AIHarness {}

export class SessionDO extends service.SessionDO {}
export class TenantCatalogDO extends CatalogObject {}
export { HarnessContainer as HarnessDO };
export class SandboxDO extends SandboxContainer {}
export { ContainerProxy };
export default class AgentWorker extends service.AgentWorker {}

/** Only the harness's private outbound handler can call this Service Binding. */
export class Models extends WorkerEntrypoint<Bindings> {
  override async fetch(request: Request): Promise<Response> {
    if (!this.env.OPENAI_API_KEY)
      return new Response("Model credentials are not configured", { status: 503 });
    const url = new URL(request.url);
    if (url.pathname !== "/v1/responses" || request.method !== "POST")
      return new Response("Unsupported endpoint", { status: 404 });
    return fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      body: request.body,
      headers: {
        authorization: `Bearer ${this.env.OPENAI_API_KEY}`,
        "content-type": "application/json",
        accept: "text/event-stream",
      },
      redirect: "error",
    });
  }
}
