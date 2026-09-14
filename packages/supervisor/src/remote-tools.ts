import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Execution, JsonValue, RuntimeEvent } from "cf-open-agents-api";
import { z } from "zod";

export class RemoteTools {
  readonly tools: {
    definition: Tool;
    codeName: string;
    server: string;
    name: string;
    client: Client;
  }[] = [];
  private readonly clients: Client[] = [];
  constructor(
    private readonly signal: AbortSignal,
    private readonly emit: (event: RuntimeEvent) => void,
  ) {}
  async open(execution: Execution): Promise<void> {
    for (const server of execution.agent.tools ?? []) {
      if (server.type !== "mcp") continue;
      if (server.transport.type !== "http" || server.connection_origin === "environment")
        throw new Error("MCP must use the assigned environment/service bridge");
      const client = new Client({ name: "cf-native-tools", version: "1" });
      this.clients.push(client);
      try {
        await client.connect(
          new StreamableHTTPClientTransport(new URL(server.transport.server_url), {
            requestInit: {
              headers: {
                ...server.transport.headers,
                ...(server.transport.authorization
                  ? { authorization: server.transport.authorization }
                  : {}),
              },
              signal: this.signal,
            },
          }),
          { signal: this.signal, timeout: Math.min(30_000, execution.deadline - Date.now()) },
        );
        let cursor: string | undefined;
        const seen = new Set<string>();
        do {
          const page = await client.listTools({ cursor }, { signal: this.signal });
          for (const tool of page.tools) {
            if (server.allowed_tools && !server.allowed_tools.includes(tool.name)) continue;
            if (
              this.tools.length >= 1000 ||
              this.tools.some(
                (entry) => entry.server === server.server_label && entry.name === tool.name,
              )
            )
              throw new Error("Invalid MCP tool catalog");
            const name = `remote_${this.tools.length}__${tool.name.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 40)}`;
            this.tools.push({
              definition: {
                ...tool,
                name,
                description: `${server.server_label}/${tool.name}: ${tool.description ?? ""}`,
              },
              codeName: `mcp__${server.server_label}__${tool.name}`,
              server: server.server_label,
              name: tool.name,
              client,
            });
          }
          cursor = page.nextCursor;
          if (cursor && seen.has(cursor)) throw new Error("MCP pagination did not advance");
          if (cursor) seen.add(cursor);
        } while (cursor);
      } catch (error) {
        await client.close();
        for (let i = this.tools.length - 1; i >= 0; i--)
          if (this.tools[i]?.client === client) this.tools.splice(i, 1);
        if (server.required || this.signal.aborted) throw error;
      }
    }
  }
  async call(name: string, input: unknown): Promise<JsonValue> {
    const tool = this.tools.find(
      (entry) => entry.definition.name === name || entry.codeName === name,
    );
    if (!tool) throw new Error("Unknown MCP tool");
    const args = z
      .record(z.string(), z.json())
      .parse(
        z
          .fromJSONSchema(z.record(z.string(), z.json()).parse(tool.definition.inputSchema))
          .parse(input ?? {}),
      );
    const id = `mcp_${crypto.randomUUID().replaceAll("-", "")}`;
    try {
      const result = z.json().parse(
        await tool.client.callTool({ name: tool.name, arguments: args }, undefined, {
          signal: this.signal,
          timeout: 120_000,
        }),
      );
      this.emit({
        type: "mcp",
        id,
        name: tool.name,
        server: tool.server,
        arguments: args,
        output: result,
        error: null,
        success: !(result && typeof result === "object" && "isError" in result && result.isError),
      });
      return result;
    } catch (error) {
      this.emit({
        type: "mcp",
        id,
        name: tool.name,
        server: tool.server,
        arguments: args,
        output: null,
        error: "MCP request failed",
        success: false,
      });
      throw error;
    }
  }
  async close(): Promise<void> {
    await Promise.all(this.clients.map((client) => client.close()));
  }
}
