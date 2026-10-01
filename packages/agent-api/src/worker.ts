import { DirectoryBackupGateway } from "@cloudflare/sandbox";
import { WorkerEntrypoint } from "cloudflare:workers";

import { CatalogObject } from "./catalog.js";
import {
  type ContainerBindings,
  ContainerEgress,
  containerEnvironments,
  containerHarnesses,
  type ContainerInstance,
  HarnessContainer,
  SandboxContainer,
  SandboxEgress,
} from "./containers.js";
import { createModelGateway, type ModelRegistration } from "./models/gateway.js";
import type { AgentRegistration, ServiceOptions } from "./runtime.js";
import { type AgentBindings, type AgentServiceClasses, createAgentService } from "./service.js";

/**
 * Every class a deployment exports. Wrangler binds the Durable Objects by these
 * names and the model gateway by the `Models` entrypoint; re-export them unchanged:
 *
 * ```ts
 * export const {
 *   Agents, Models, SessionDO, TenantCatalogDO, HarnessDO, SandboxDO,
 *   ContainerEgress, SandboxEgress, DirectoryBackupGateway,
 * } = defineAgentWorker<Bindings>({ ... });
 * export default Agents;
 * ```
 *
 * The container objects find `ContainerEgress`, `SandboxEgress` and `DirectoryBackupGateway`
 * through `ctx.exports` by these names, so the main module exports them unrenamed.
 */
export interface AgentWorkerClasses<Env extends AgentBindings> {
  Agents: AgentServiceClasses<Env>["AgentWorker"];
  Models: new (ctx: ExecutionContext, env: Env) => WorkerEntrypoint<Env>;
  SessionDO: AgentServiceClasses<Env>["SessionDO"];
  TenantCatalogDO: typeof CatalogObject;
  HarnessDO: typeof HarnessContainer;
  SandboxDO: typeof SandboxContainer;
  ContainerEgress: typeof ContainerEgress;
  SandboxEgress: typeof SandboxEgress;
  DirectoryBackupGateway: typeof DirectoryBackupGateway;
}

/** Container sizes; `standard-1` (1/2 vCPU, 4 GiB) by default for both. */
export interface ContainerInstances {
  harness?: ContainerInstance;
  sandbox?: ContainerInstance;
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
  instances?: ContainerInstances;
}
/** Custom composition without Container bindings: every driver is supplied explicitly. */
export interface CustomAgentWorkerOptions<
  Env extends AgentBindings,
> extends BaseAgentWorkerOptions<Env> {
  harnesses: ServiceOptions<Env>["harnesses"];
  environments?: ServiceOptions<Env>["environments"];
  objects?: ServiceOptions<Env>["objects"];
  harness?: undefined;
  instances?: undefined;
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
  instances?: ContainerInstances;
}

const sizedHarness = (Base: typeof HarnessContainer, size: ContainerInstance) =>
  class extends Base {
    protected override instance = size;
  } as typeof HarnessContainer;
const sizedSandbox = (size: ContainerInstance) =>
  class extends SandboxContainer {
    protected override instance = size;
  } as typeof SandboxContainer;

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
  const Harness = options.harness ?? HarnessContainer;
  const harnessInstance = options.instances?.harness;
  const sandboxInstance = options.instances?.sandbox;
  return {
    Agents: service.AgentWorker,
    Models,
    SessionDO: service.SessionDO,
    TenantCatalogDO: CatalogObject,
    HarnessDO: harnessInstance ? sizedHarness(Harness, harnessInstance) : Harness,
    SandboxDO: sandboxInstance ? sizedSandbox(sandboxInstance) : SandboxContainer,
    ContainerEgress,
    SandboxEgress,
    DirectoryBackupGateway,
  };
}
