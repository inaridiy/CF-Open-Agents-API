import { join } from "node:path";
import {
  type McpSdkServerConfigWithInstance,
  type Query,
  query,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type Execution, workspaceTools } from "cf-open-agents-api";
import { z } from "zod";
import { type NativeOptions, ToolJob } from "./job.js";
import { imageContent } from "./media.js";

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
    for (const definition of this.toolDefinitions()) {
      const schema = z.fromJSONSchema(z.record(z.string(), z.json()).parse(definition.inputSchema));
      if (!(schema instanceof z.ZodObject))
        throw new Error("Tool parameters must describe an object");
      instance.registerTool(
        definition.name,
        { description: definition.description, inputSchema: schema },
        (args) => this.callTool(definition.name, args),
      );
    }
    const workspace: McpSdkServerConfigWithInstance = {
      type: "sdk",
      name: "workspace",
      instance,
      timeout: Math.max(1000, this.execution.deadline - Date.now()),
    };
    const content = await Promise.all(
      this.execution.input
        .flatMap((message) => message.content)
        .map(async (part) => {
          if (part.type === "input_text") return { type: "text" as const, text: part.text };
          const image = await imageContent(
            part.image_url,
            this.abort.signal,
            this.options.mediaUrl,
          );
          return {
            type: "image" as const,
            source: {
              type: "base64" as const,
              media_type: z
                .enum(["image/png", "image/jpeg", "image/gif", "image/webp"])
                .parse(image.mimeType),
              data: image.data,
            },
          };
        }),
    );
    const prompt: SDKUserMessage = {
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
      session_id: previous ?? "",
    };
    const session = query({
      prompt: (async function* () {
        yield prompt;
      })(),
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
        thinking:
          this.execution.agent.reasoning?.effort && this.execution.agent.reasoning.effort !== "none"
            ? { type: "adaptive" }
            : { type: "disabled" },
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
          // Text that precedes tool use is commentary; the closing message is the answer.
          const phase = message.message.content.some((part) => part.type === "tool_use")
            ? "commentary"
            : "final_answer";
          for (const [index, part] of message.message.content.entries()) {
            if (part.type === "text")
              this.emit({
                type: "text",
                id: `${message.message.id}:${index}`,
                text: part.text,
                phase,
              });
            else if (part.type === "thinking")
              this.emit({
                type: "reasoning",
                id: `${message.message.id}:${index}`,
                summary: [part.thinking],
                status: "completed",
              });
          }
        } else if (message.type === "stream_event") {
          if (message.event.type === "message_start") messageId = message.event.message.id;
          if (
            messageId &&
            message.event.type === "content_block_start" &&
            message.event.content_block.type === "thinking"
          ) {
            this.emit({
              type: "reasoning",
              id: `${messageId}:${message.event.index}`,
              summary: [],
              status: "in_progress",
            });
            this.emit({
              type: "reasoning_part",
              id: `${messageId}:${message.event.index}`,
              summaryIndex: 0,
              text: message.event.content_block.thinking,
            });
          }
          if (
            messageId &&
            message.event.type === "content_block_delta" &&
            message.event.delta.type === "thinking_delta"
          )
            this.emit({
              type: "reasoning_delta",
              id: `${messageId}:${message.event.index}`,
              summaryIndex: 0,
              text: message.event.delta.thinking,
            });
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
          const models = Object.values(message.modelUsage);
          const input = models.reduce(
            (sum, model) =>
              sum + model.inputTokens + model.cacheReadInputTokens + model.cacheCreationInputTokens,
            0,
          );
          const output = models.reduce((sum, model) => sum + model.outputTokens, 0);
          this.emit({
            type: "usage",
            id: `usage:${this.execution.turnId}`,
            usage: {
              input_tokens: input,
              output_tokens: output,
              total_tokens: input + output,
              input_tokens_details: {
                cached_tokens: models.reduce((sum, model) => sum + model.cacheReadInputTokens, 0),
              },
              output_tokens_details: {
                reasoning_tokens: models.reduce(
                  (sum, model) => sum + (model.thinkingTokens ?? 0),
                  0,
                ),
              },
            },
          });
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
