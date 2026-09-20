import { Effect } from "effect";

import {
  type Capability,
  CapabilityUnsupported,
  DelegateUnavailable,
  ImageLimitExceeded,
  McpPlacementInvalid,
  ModelNotRegistered,
  ReservedToolName,
} from "./errors.js";
import type { AgentConfig, CreateSession } from "./protocol.js";
import { IMAGE_LIMIT, remoteImageURLs, reservedDelegationName } from "./protocol.js";
import type { AgentRegistration, RuntimeDriver, ServiceOptions } from "./runtime.js";

/**
 * What a session configuration needs from the deployment before any state exists: a
 * registered preset whose driver can execute the tools, sandbox and delegation it names.
 */
/** The subset of an agent configuration the driver checks accept, saved or inline. */
export interface ModelAgent {
  tools?: readonly { type: string; defer_loading?: boolean; enabled?: boolean }[] | null;
  multi_agent?: { enabled: boolean } | null;
}
/** Reject configurations the selected driver cannot execute before any state exists. */
export function validateModel<Env>(
  options: ServiceOptions<Env>,
  env: Env,
  model: string,
  agent: ModelAgent,
  sandbox: boolean,
) {
  return Effect.gen(function* () {
    const registration = options.agents[model];
    const driver = registration && options.harnesses(env)[registration.harness];
    if (!registration || !driver) return yield* new ModelNotRegistered({ alias: model });
    const tools = agent.tools ?? [];
    const unsupported = (capability: Capability) =>
      new CapabilityUnsupported({ capability, harness: driver.name });
    const configuration = configurationGap(tools, agent, sandbox, registration, driver);
    if (configuration) return yield* unsupported(configuration);
    if (reservedDelegationName(agent)) return yield* new ReservedToolName();
    if (agent.multi_agent?.enabled) {
      const alias = unavailableDelegate(registration, options.agents, () => options.harnesses(env));
      if (alias !== undefined) return yield* new DelegateUnavailable({ alias });
    }
    const tooling = toolCapabilityGap(tools, registration, driver);
    if (tooling) return yield* unsupported(tooling);
    return { registration, driver };
  });
}
/** MCP placement rules that depend on the environment rather than the driver. */
export function validateMcp(agent: AgentConfig, hosted: boolean) {
  return Effect.gen(function* () {
    for (const tool of agent.tools ?? []) {
      if (tool.type !== "mcp") continue;
      const environmentOrigin =
        tool.transport.type === "stdio" || tool.connection_origin === "environment";
      if (environmentOrigin && !hosted)
        return yield* new McpPlacementInvalid({ rule: "environment_required" });
      if (tool.transport.type === "stdio" && tool.connection_origin === "service")
        return yield* new McpPlacementInvalid({ rule: "stdio_in_service" });
      if (
        environmentOrigin &&
        (tool.credential_id || Object.keys(tool.request_metadata ?? {}).length)
      )
        return yield* new CapabilityUnsupported({ capability: "environment_mcp_credentials" });
    }
  });
}
/** The capability a driver lacks for this configuration's shape, checked before the tool surface. */
function configurationGap(
  tools: NonNullable<ModelAgent["tools"]>,
  agent: ModelAgent,
  sandbox: boolean,
  registration: AgentRegistration,
  driver: RuntimeDriver,
): Capability | undefined {
  if (
    (tools.length > 0 && !driver.capabilities.functions) ||
    (sandbox && !driver.capabilities.sandbox)
  )
    return "configuration";
  if (
    agent.multi_agent?.enabled &&
    !driver.capabilities.subagents &&
    !registration.delegates?.length
  )
    return "subagents";
  return;
}
/** The first delegate alias the deployment cannot run, when delegation is enabled. */
function unavailableDelegate(
  registration: AgentRegistration,
  agents: Record<string, AgentRegistration>,
  harnesses: () => Record<string, RuntimeDriver>,
): string | undefined {
  for (const alias of registration.delegates ?? []) {
    const target = agents[alias];
    if (!target || !harnesses()[target.harness]) return alias;
  }
  return;
}
/** The capability a driver lacks for one of the configured tools, in the order the API reports them. */
function toolCapabilityGap(
  tools: NonNullable<ModelAgent["tools"]>,
  registration: AgentRegistration,
  driver: RuntimeDriver,
): Capability | undefined {
  if (tools.some((tool) => tool.type === "mcp") && !driver.capabilities.mcp) return "mcp";
  // Hosted search needs both a runtime that drives it and a model connection that provides it.
  if (
    tools.some((tool) => tool.type === "web_search") &&
    !(driver.capabilities.webSearch && registration.webSearch === true)
  )
    return "web_search";
  if (
    tools.some(
      (tool) => tool.type === "tool_search" || (tool.type === "function" && tool.defer_loading),
    ) &&
    !driver.capabilities.toolSearch
  )
    return "tool_search";
  if (
    tools.some((tool) => tool.type === "programmatic_tool_calling" && tool.enabled !== false) &&
    !driver.capabilities.programmaticToolCalling
  )
    return "programmatic_tool_calling";
  return;
}
export const hasImageInput = (input: CreateSession["input"]): boolean =>
  Array.isArray(input) &&
  input.some((message) => message.content.some((part) => part.type === "input_image"));
/** Remote images are bounded per request before any state exists. */
export const checkInputImages = (input: CreateSession["input"]) =>
  Effect.suspend(() =>
    Array.isArray(input) &&
    remoteImageURLs(input.flatMap((message) => message.content)).size > IMAGE_LIMIT
      ? new ImageLimitExceeded({ limit: IMAGE_LIMIT, scope: "request" })
      : Effect.void,
  );
