import type { Execution } from "cf-open-agents-api";

/**
 * Deployment-owned additions to the generated Codex config: extra `[features]`
 * flags and `[model_providers.gateway]` keys such as retry counts. Values are
 * written as TOML literals; they cannot change the provider URL or auth.
 */
export interface CodexConfig {
  features?: Record<string, boolean>;
  provider?: Record<string, string | number | boolean>;
}
export interface CodexConfigOptions {
  modelBaseUrl: string;
  codexConfig?: CodexConfig;
}
type WebSearchTool = Extract<
  NonNullable<Execution["agent"]["tools"]>[number],
  { type: "web_search" }
>;
export const searchConfig = (tool: WebSearchTool) => ({
  context_size: tool.context_size ?? "medium",
  ...(tool.allowed_domains == null ? {} : { allowed_domains: tool.allowed_domains }),
  ...(tool.location == null ? {} : { location: tool.location }),
});

const RESERVED_PROVIDER_KEYS = new Set(["name", "base_url", "wire_api", "requires_openai_auth"]);
const tomlLines = (
  entries: Record<string, string | number | boolean> | undefined,
  reserved = new Set<string>(),
) =>
  Object.entries(entries ?? {})
    .filter(([key]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && !reserved.has(key))
    .map(([key, value]) => `${key} = ${JSON.stringify(value)}`);

/** `config.toml` for one job: the gateway provider, the agent's model settings and the deployment's additions. */
export function configToml(
  execution: Execution,
  options: CodexConfigOptions,
  searchMode: string,
): string {
  return [
    'model_provider = "gateway"',
    `model = ${JSON.stringify(execution.model)}`,
    'approval_policy = "never"',
    'sandbox_mode = "danger-full-access"',
    `web_search = ${JSON.stringify(searchMode)}`,
    ...(execution.agent.reasoning?.effort
      ? [`model_reasoning_effort = ${JSON.stringify(execution.agent.reasoning.effort)}`]
      : []),
    ...(execution.agent.reasoning?.summary
      ? [`model_reasoning_summary = ${JSON.stringify(execution.agent.reasoning.summary)}`]
      : []),
    ...(execution.agent.text?.verbosity
      ? [`model_verbosity = ${JSON.stringify(execution.agent.text.verbosity)}`]
      : []),
    "[features]",
    `multi_agent = ${execution.agent.multi_agent?.enabled ?? false}`,
    `plugins = ${!!execution.capabilityRoots?.length}`,
    `remote_plugin = ${!!execution.capabilityRoots?.length}`,
    `executor_capability_discovery = ${!!execution.capabilityRoots?.length}`,
    ...(execution.agent.tools?.some(
      (tool) => tool.type === "tool_search" || (tool.type === "function" && tool.defer_loading),
    )
      ? ["tool_search = true"]
      : []),
    ...tomlLines(options.codexConfig?.features),
    "[agents]",
    `max_concurrent_threads_per_session = ${execution.agent.multi_agent?.max_concurrent_subagents ?? 6}`,
    "[model_providers.gateway]",
    'name = "Deployment model gateway"',
    `base_url = ${JSON.stringify(options.modelBaseUrl)}`,
    'wire_api = "responses"',
    "requires_openai_auth = false",
    ...tomlLines(options.codexConfig?.provider, RESERVED_PROVIDER_KEYS),
  ].join("\n");
}
/** `environments.toml`: the remote sandbox when the execution has one, else no environment. */
export function environmentsToml(execution: Execution, sandboxUrl: string): string {
  return execution.sandbox
    ? `default = "sandbox"\ninclude_local = false\n[[environments]]\nid = "sandbox"\nurl = ${JSON.stringify(sandboxUrl)}\n`
    : 'default = "none"\ninclude_local = false\n';
}
/** The preset's MCP servers as Codex `mcp_servers` entries; stdio and environment-origin servers run in the sandbox. */
export function mcpServers(execution: Execution) {
  return Object.fromEntries(
    (execution.agent.tools ?? [])
      .filter((tool) => tool.type === "mcp")
      .map((tool) => {
        const transport = tool.transport;
        const headers =
          transport.type === "http"
            ? {
                ...transport.headers,
                ...(transport.authorization ? { Authorization: transport.authorization } : {}),
              }
            : undefined;
        return [
          tool.server_label,
          {
            required: tool.required ?? false,
            ...(tool.allowed_tools ? { enabled_tools: tool.allowed_tools } : {}),
            ...(transport.type === "stdio" || tool.connection_origin === "environment"
              ? { environment_id: "sandbox" }
              : {}),
            ...(transport.type === "http"
              ? { url: transport.server_url, http_headers: headers ?? {} }
              : {
                  command: transport.command,
                  args: transport.args ?? [],
                  cwd: transport.cwd,
                  env: transport.env ?? {},
                  env_vars: transport.env_vars ?? [],
                }),
          },
        ];
      }),
  );
}
