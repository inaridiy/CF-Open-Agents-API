import { ContainerProxy } from "@cloudflare/sandbox";
import { WorkerEntrypoint } from "cloudflare:workers";

import { CatalogObject } from "./catalog.js";
import {
  type ContainerBindings,
  containerEnvironments,
  containerHarnesses,
  HarnessContainer,
  SandboxContainer,
} from "./containers.js";
import { createModelGateway, type ModelRegistration } from "./models/gateway.js";
import type { AgentRegistration, ServiceOptions } from "./runtime.js";
import { type AgentBindings, type AgentServiceClasses, createAgentService } from "./service.js";

/**
 * Every class a deployment exports. Wrangler binds the Durable Objects by these
 * names and the model gateway by the `Models` entrypoint; re-export them unchanged:
 *
 * ```ts
 * export const { Agents, Models, SessionDO, TenantCatalogDO, HarnessDO, SandboxDO, ContainerProxy } =
 *   defineAgentWorker<Bindings>({ ... });
 * export default Agents;
 * ```
 *
 * `HarnessDO` is the `HarnessContainer` class itself, never a subclass: the Container
 * SDK keys its outbound handler registry by class name. Use the `harness` option for a
 * `createHarness(...)` class.
 */
export interface AgentWorkerClasses<Env extends AgentBindings> {
  Agents: AgentServiceClasses<Env>["AgentWorker"];
  Models: new (ctx: ExecutionContext, env: Env) => WorkerEntrypoint<Env>;
  SessionDO: AgentServiceClasses<Env>["SessionDO"];
  TenantCatalogDO: typeof CatalogObject;
  HarnessDO: typeof HarnessContainer;
  SandboxDO: typeof SandboxContainer;
  ContainerProxy: typeof ContainerProxy;
}

interface BaseAgentWorkerOptions<Env> {
  /** Presets: public `agent.model` names mapped to a harness and a gateway model name. */
  agents: Record<string, AgentRegistration>;
  /** The private model gateway registry; entries may be factories built on first use. */
  models: (env: Env) => Record<string, ModelRegistration>;
  authenticate: ServiceOptions<Env>["authenticate"];
  maxTurnMs?: number;
  pollIntervalMs?: number;
}
/**
 * Container composition. Without `harnesses`, the drivers, the environment driver and
 * the object bucket are the Containers (`containerHarnesses`, `containerEnvironments`,
 * `env.CHECKPOINTS`). A composition that supplies `harnesses` supplies the other two as well.
 */
export interface ContainerAgentWorkerOptions<
  Env extends AgentBindings & ContainerBindings,
> extends BaseAgentWorkerOptions<Env> {
  harnesses?: ServiceOptions<Env>["harnesses"];
  environments?: ServiceOptions<Env>["environments"];
  objects?: ServiceOptions<Env>["objects"];
  /** A `createHarness(...)` class to export as `HarnessDO` in place of `HarnessContainer`. */
  harness?: typeof HarnessContainer;
}
/** Custom composition without Container bindings: every driver is supplied explicitly. */
export interface CustomAgentWorkerOptions<
  Env extends AgentBindings,
> extends BaseAgentWorkerOptions<Env> {
  harnesses: ServiceOptions<Env>["harnesses"];
  environments?: ServiceOptions<Env>["environments"];
  objects?: ServiceOptions<Env>["objects"];
  harness?: undefined;
}
export type AgentWorkerOptions<Env extends AgentBindings> = Env extends ContainerBindings
  ? ContainerAgentWorkerOptions<Env>
  : CustomAgentWorkerOptions<Env>;
/** The overloads decide which fields are required; the implementation accepts either. */
interface ImplementationOptions<Env> extends BaseAgentWorkerOptions<Env> {
  harnesses?: ServiceOptions<Env>["harnesses"];
  environments?: ServiceOptions<Env>["environments"];
  objects?: ServiceOptions<Env>["objects"];
  harness?: typeof HarnessContainer;
}

/** One call composes the API Worker, the SessionDO and the private model gateway. */
export function defineAgentWorker<Env extends AgentBindings & ContainerBindings>(
  options: ContainerAgentWorkerOptions<Env>,
): AgentWorkerClasses<Env>;
export function defineAgentWorker<Env extends AgentBindings>(
  options: CustomAgentWorkerOptions<Env>,
): AgentWorkerClasses<Env>;
export function defineAgentWorker<Env extends AgentBindings>(
  options: ImplementationOptions<Env>,
): AgentWorkerClasses<Env> {
  const containers = (env: Env) => env as Env & ContainerBindings;
  // Omitting `harnesses` selects the Container composition as a whole; a composition
  // that names its drivers also names its environment driver and object bucket.
  const service = createAgentService<Env>({
    agents: options.agents,
    authenticate: options.authenticate,
    maxTurnMs: options.maxTurnMs,
    pollIntervalMs: options.pollIntervalMs,
    harnesses: options.harnesses ?? ((env) => containerHarnesses(containers(env))),
    environments:
      options.environments ??
      (options.harnesses ? undefined : (env) => containerEnvironments(containers(env))),
    objects:
      options.objects ?? (options.harnesses ? undefined : (env) => containers(env).CHECKPOINTS),
  });
  const gateway = createModelGateway<Env>(options.models);
  class Models extends WorkerEntrypoint<Env> {
    override fetch(request: Request): Promise<Response> {
      return gateway.fetch(request, this.env);
    }
  }
  return {
    Agents: service.AgentWorker,
    Models,
    SessionDO: service.SessionDO,
    TenantCatalogDO: CatalogObject,
    HarnessDO: options.harness ?? HarnessContainer,
    SandboxDO: SandboxContainer,
    ContainerProxy,
  };
}
