import { Effect } from "effect";
import type { McpToolConfig } from "./agent-tools.js";
import { io } from "./effect.js";
import { requestWithoutRedirect } from "./http.js";
import { ApiError } from "./protocol.js";

/** One fixed destination per configured server. No client-controlled redirect target. */
export function proxyMcp(
  request: Request,
  tool: McpToolConfig,
  token?: string,
  send: (request: Request) => Promise<Response> = fetch,
) {
  return Effect.gen(function* () {
    if (tool.transport.type !== "http")
      return yield* new ApiError(400, "invalid_request", "Expected HTTP MCP");
    const headers = new Headers();
    for (const name of [
      "accept",
      "content-type",
      "mcp-session-id",
      "mcp-protocol-version",
      "last-event-id",
    ]) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
    for (const [name, value] of Object.entries(tool.transport.headers ?? {}))
      headers.set(name, value);
    if (tool.transport.authorization) headers.set("authorization", tool.transport.authorization);
    if (token) {
      if (headers.has("authorization"))
        return yield* new ApiError(
          400,
          "ambiguous_credential",
          "Use either inline or vault authorization",
        );
      headers.set("authorization", `Bearer ${token}`);
    }
    let body: BodyInit | undefined;
    if (request.method === "POST") {
      const message = yield* io("mcp.decode", () => request.json<Record<string, unknown>>());
      if (message.method && tool.request_metadata && Object.keys(tool.request_metadata).length) {
        const params =
          typeof message.params === "object" && message.params !== null
            ? (message.params as Record<string, unknown>)
            : {};
        message.params = {
          ...params,
          _meta: {
            ...(typeof params._meta === "object" && params._meta !== null ? params._meta : {}),
            ...tool.request_metadata,
          },
        };
      }
      body = JSON.stringify(message);
    }
    if (!["GET", "POST", "DELETE"].includes(request.method))
      return new Response(null, { status: 405 });
    return yield* requestWithoutRedirect(
      "mcp.request",
      new Request(tool.transport.server_url, {
        method: request.method,
        headers,
        body,
        signal: request.signal,
      }),
      send,
    );
  });
}
