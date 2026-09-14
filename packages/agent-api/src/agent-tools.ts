import { z } from "zod";

/** The Responses/Agents API charset: letters, digits, underscores and hyphens, up to 64. */
const toolName = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
export const functionToolSchema = z.strictObject({
  type: z.literal("function"),
  name: toolName,
  description: z.string(),
  parameters: z.record(z.string(), z.json()),
  defer_loading: z.boolean().optional(),
});
export const mcpToolSchema = z.strictObject({
  type: z.literal("mcp"),
  server_label: toolName,
  transport: z.discriminatedUnion("type", [
    z.strictObject({
      type: z.literal("http"),
      server_url: z.url().refine((value) => {
        const url = new URL(value);
        return (
          ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.hash
        );
      }),
      authorization: z.string().nullable().optional(),
      headers: z.record(z.string(), z.string()).nullable().optional(),
    }),
    z.strictObject({
      type: z.literal("stdio"),
      command: z.string().min(1),
      cwd: z.string().startsWith("/"),
      args: z.array(z.string()).nullable().optional(),
      env: z.record(z.string(), z.string()).nullable().optional(),
      env_vars: z.array(z.string()).nullable().optional(),
    }),
  ]),
  allowed_tools: z.array(z.string()).nullable().optional(),
  connection_origin: z.enum(["service", "environment"]).nullable().optional(),
  credential_id: z.string().nullable().optional(),
  request_metadata: z.record(z.string(), z.json()).nullable().optional(),
  required: z.boolean().optional(),
});
export const agentToolSchema = z.discriminatedUnion("type", [
  functionToolSchema,
  mcpToolSchema,
  z.strictObject({ type: z.literal("programmatic_tool_calling"), enabled: z.boolean().optional() }),
  z.strictObject({ type: z.literal("tool_search") }),
  z.strictObject({
    type: z.literal("web_search"),
    mode: z.enum(["disabled", "cached", "live"]).nullable().optional(),
    context_size: z.enum(["low", "medium", "high"]).nullable().optional(),
    allowed_domains: z.array(z.string().min(1)).max(100).nullable().optional(),
    location: z
      .strictObject({
        city: z.string().nullable().optional(),
        country: z.string().nullable().optional(),
        region: z.string().nullable().optional(),
        timezone: z.string().nullable().optional(),
      })
      .nullable()
      .optional(),
  }),
]);
export type AgentToolConfig = z.infer<typeof agentToolSchema>;
export type McpToolConfig = z.infer<typeof mcpToolSchema>;
export function publicTool(tool: AgentToolConfig) {
  if (tool.type === "function") return { ...tool, defer_loading: tool.defer_loading ?? false };
  if (tool.type === "tool_search") return tool;
  if (tool.type === "programmatic_tool_calling") return { ...tool, enabled: tool.enabled ?? true };
  if (tool.type === "web_search")
    return {
      type: tool.type,
      mode: tool.mode ?? "live",
      context_size: tool.context_size ?? "medium",
      allowed_domains: tool.allowed_domains ?? null,
      location: tool.location
        ? {
            city: tool.location.city ?? null,
            country: tool.location.country ?? null,
            region: tool.location.region ?? null,
            timezone: tool.location.timezone ?? null,
          }
        : null,
    };
  return {
    type: tool.type,
    server_label: tool.server_label,
    allowed_tools: tool.allowed_tools ?? null,
    connection_origin:
      tool.connection_origin ??
      (tool.transport.type === "stdio" ? ("environment" as const) : ("service" as const)),
    credential_id: tool.credential_id ?? null,
    request_metadata: tool.request_metadata ?? {},
    required: tool.required ?? false,
    transport:
      tool.transport.type === "http"
        ? {
            type: tool.transport.type,
            server_url: tool.transport.server_url,
            headers: tool.transport.headers ?? {},
          }
        : {
            type: tool.transport.type,
            command: tool.transport.command,
            cwd: tool.transport.cwd,
            args: tool.transport.args ?? [],
            env_vars: tool.transport.env_vars ?? [],
          },
  };
}
/**
 * The session's agent view. The SDK's `AgentSession.agent.tools` union (`AgentTool`)
 * has no `tool_search` member, unlike the persisted `Agent` resource, so that entry
 * is omitted here and inline MCP secrets never leave the Worker.
 */
export function sessionTools(tools: AgentToolConfig[]) {
  return tools
    .map(publicTool)
    .filter((tool) => tool.type !== "tool_search")
    .map((tool) => {
      if (tool.type !== "mcp" || tool.transport.type !== "http") return tool;
      const { headers: _headers, ...transport } = tool.transport;
      return { ...tool, transport };
    });
}
export function credentialFreeTools(tools: AgentToolConfig[]): boolean {
  return tools.every(
    (tool) =>
      tool.type !== "mcp" ||
      (tool.transport.type === "http"
        ? !tool.transport.authorization &&
          !Object.keys(tool.transport.headers ?? {}).some((name) =>
            /^(authorization|proxy-authorization|x-api-key|cookie)$/i.test(name),
          )
        : !Object.keys(tool.transport.env ?? {}).length),
  );
}
