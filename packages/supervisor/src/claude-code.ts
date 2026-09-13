import { join } from "node:path";
import {
  type McpSdkServerConfigWithInstance,
  type Query,
  query,
} from "@anthropic-ai/claude-agent-sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type Execution, workspaceTools } from "cf-open-agents-api";
import { z } from "zod";
import { type NativeOptions, ToolJob } from "./job.js";

export class ClaudeCodeJob extends ToolJob {
  readonly home: string;
  private query?: Query;
  private workspaceServer?: McpServer;
  constructor(execution: Execution, options: NativeOptions) {
    super(execution, options);
    this.home = join(options.directory, "claude-code");
  }
  protected async open(bundle?: unknown): Promise<void> {
    const previous = await this.prepare(bundle);
    const aliases = this.execution.sandbox
      ? Object.fromEntries(
          Object.keys(workspaceTools).map((name) => [
            name.charAt(0).toUpperCase() + name.slice(1),
            `mcp__workspace__${name}`,
          ]),
        )
      : {};
    // Use the installed MCP SDK: the Claude bundle's older Zod parser cannot
    // safely combine its object schemas with current Zod optional/default fields.
    const instance = new McpServer({ name: "workspace", version: "1" });
    this.workspaceServer = instance;
    if (this.execution.sandbox)
      for (const [name, definition] of Object.entries(workspaceTools)) {
        instance.registerTool(
          name,
          { description: definition.description, inputSchema: definition.schema },
          async (args: unknown) => {
            const result = await this.workspace(name as keyof typeof workspaceTools, args);
            return {
              content: [{ type: "text" as const, text: result.text }],
              isError: result.exitCode !== null && result.exitCode !== 0,
            };
          },
        );
      }
    for (const [index, definition] of (this.execution.agent.tools ?? []).entries()) {
      const schema = z.fromJSONSchema(definition.parameters);
      if (!(schema instanceof z.ZodObject))
        throw new Error("Function parameters must describe an object");
      instance.registerTool(
        `function_${index}`,
        { description: `${definition.name}: ${definition.description}`, inputSchema: schema },
        (args) => this.externalTool(definition.name, args),
      );
    }
    const workspace: McpSdkServerConfigWithInstance = {
      type: "sdk",
      name: "workspace",
      instance,
      timeout: Math.max(1000, this.execution.deadline - Date.now()),
    };
    const session = query({
      prompt: this.execution.input
        .flatMap((message) => message.content.map((part) => part.text))
        .join("\n"),
      options: {
        cwd: this.options.directory,
        model: this.execution.model,
        resume: previous,
        tools: [],
        disallowedTools: [
          "Bash",
          "Read",
          "Write",
          "Edit",
          "Glob",
          "Grep",
          "Task",
          "Agent",
          "WebFetch",
          "WebSearch",
        ],
        toolAliases: aliases,
        settingSources: [],
        strictMcpConfig: true,
        persistSession: true,
        enableFileCheckpointing: false,
        mcpServers: { workspace },
        canUseTool: async (name, input) =>
          name.startsWith("mcp__workspace__")
            ? { behavior: "allow", updatedInput: input }
            : { behavior: "deny", message: "Only deployment-owned workspace tools are available" },
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append: this.execution.agent.instructions ?? "",
        },
        maxTurns: 32,
        thinking: { type: "disabled" },
        abortController: this.abort,
        includePartialMessages: true,
        env: {
          PATH: process.env.PATH,
          HOME: this.home,
          CLAUDE_CONFIG_DIR: this.home,
          ANTHROPIC_API_KEY: "private-worker-gateway",
          ANTHROPIC_BASE_URL: this.options.modelBaseUrl.replace(/\/v1\/?$/, ""),
          ANTHROPIC_DEFAULT_HAIKU_MODEL: this.execution.model,
          ANTHROPIC_DEFAULT_SONNET_MODEL: this.execution.model,
          ANTHROPIC_DEFAULT_OPUS_MODEL: this.execution.model,
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        },
        stderr: this.options.diagnostics,
      },
    });
    this.query = session;
    this.run(async () => {
      let completed = false;
      let messageId = "";
      for await (const message of session) {
        if (message.session_id) this.sessionId = message.session_id;
        if (
          message.type === "system" &&
          message.subtype === "init" &&
          !message.mcp_servers.some(
            (server) => server.name === "workspace" && server.status === "connected",
          )
        )
          throw new Error("Workspace MCP server failed to connect");
        if (message.type === "assistant") {
          for (const [index, part] of message.message.content.entries()) {
            if (part.type === "text")
              this.emit({
                type: "text",
                id: `${message.message.id}:${index}`,
                text: part.text,
                phase: "final_answer",
              });
          }
        } else if (message.type === "stream_event") {
          if (message.event.type === "message_start") messageId = message.event.message.id;
          if (
            messageId &&
            message.event.type === "content_block_delta" &&
            message.event.delta.type === "text_delta"
          )
            this.emit({
              type: "delta",
              id: `${messageId}:${message.event.index}`,
              text: message.event.delta.text,
            });
        } else if (message.type === "result") {
          if (message.subtype !== "success" || message.is_error)
            throw new Error("Claude Code turn failed");
          completed = true;
        }
      }
      if (!completed) throw new Error("Claude Code exited without a completed result");
    });
  }
  protected async closeRuntime(): Promise<void> {
    this.query?.close();
    await this.workspaceServer?.close();
  }
}
