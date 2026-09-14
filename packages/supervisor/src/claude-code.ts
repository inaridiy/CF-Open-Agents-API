import { spawn } from "node:child_process";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  type HookCallback,
  type McpSdkServerConfigWithInstance,
  type Options,
  type Query,
  query,
  type SDKMessage,
  type SDKResultMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { BetaContentBlock } from "@anthropic-ai/sdk/resources/beta";
import type { ContentBlockParam } from "@anthropic-ai/sdk/resources/messages";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ApiError, type Execution, type InputMessage, workspaceTools } from "cf-open-agents-api";
import { z } from "zod";
import { type NativeOptions, ToolJob, type ToolScope } from "./job.js";
import type { TurnErrorCode } from "./lifecycle.js";
import { imageContent } from "./media.js";

/** Tool input key that carries a subagent attribution from the PreToolUse hook to the MCP handler. */
const SCOPE_KEY = "__cf_scope";
const INTERRUPT_GRACE_MS = 10_000;
/** Time allowed for the CLI to exit and flush its session files once its input ends. */
const EXIT_GRACE_MS = 5_000;
const SUBAGENT_PROMPT =
  "You are a subagent working on one delegated subtask for the main agent. Complete the subtask with the tools available and reply with a concise report of the result.";

/** Streaming-input prompt: stays open for the life of the turn so input can be folded in. */
class InputQueue implements AsyncIterable<SDKUserMessage> {
  private readonly items: SDKUserMessage[] = [];
  private wake?: () => void;
  closed = false;
  push(message: SDKUserMessage): void {
    if (this.closed) throw new Error("Input is closed");
    this.items.push(message);
    this.wake?.();
  }
  close(): void {
    this.closed = true;
    this.wake?.();
  }
  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage, void> {
    for (;;) {
      const next = this.items.shift();
      if (next) {
        yield next;
        continue;
      }
      if (this.closed) return;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
      this.wake = undefined;
    }
  }
}

interface Child {
  readonly scope: ToolScope;
  agentId?: string;
  taskToolUseId?: string;
  taskId?: string;
  name: string | null;
  instructions: string | null;
  readonly openedAt: number;
  status: "in_progress" | "completed" | "cancelled" | "failed";
  announced: boolean;
  textForwarded: boolean;
}

interface PendingText {
  id: string;
  text: string;
  messageId: string;
  scope?: ToolScope;
}

/** Map a Claude Code result to the public turn error code; native detail goes to diagnostics. */
export function claudeTurnError(result: SDKResultMessage): TurnErrorCode | undefined {
  if (result.subtype === "success" && !result.is_error) return undefined;
  const status = result.subtype === "success" ? result.api_error_status : undefined;
  const byStatus = (code: number | null | undefined): TurnErrorCode | undefined => {
    if (code === 401 || code === 403) return "authentication_error";
    if (code === 429) return "rate_limit_exceeded";
    if (code === 529) return "server_overloaded";
    if (code === 404) return "resource_not_found";
    if (code === 400 || code === 413 || code === 422) return "invalid_request";
    if (code !== null && code !== undefined && code >= 500) return "server_error";
    return undefined;
  };
  const errors = result.subtype === "success" ? [result.result] : result.errors;
  const text = errors.join("\n").toLowerCase();
  if (/prompt is too long|context window|context_length/.test(text))
    return "context_length_exceeded";
  if (/econnrefused|enotfound|econnreset|fetch failed|network error|socket hang up/.test(text))
    return "connection_failed";
  if (/overloaded/.test(text)) return "server_overloaded";
  const fromStatus = byStatus(status);
  if (fromStatus) return fromStatus;
  if (result.subtype === "error_max_budget_usd") return "session_budget_exceeded";
  switch (result.terminal_reason) {
    case "prompt_too_long":
      return "context_length_exceeded";
    case "budget_exhausted":
      return "session_budget_exceeded";
    case "api_error":
    case "model_error":
      return "server_error";
    case "image_error":
      return "invalid_request";
    default:
      return "internal_error";
  }
}

export class ClaudeCodeJob extends ToolJob {
  readonly home: string;
  private query?: Query;
  private input?: InputQueue;
  private workspaceServer?: McpServer;
  /** The turn produced its terminal result; late input belongs to the next public turn. */
  private finished = false;
  private settleResult?: () => void;
  /** Resolves when the CLI process has exited; the SDK ends its message stream earlier. */
  private exited?: Promise<void>;
  private readonly children: Child[] = [];
  private readonly innerToolUses = new Map<string, Child>();
  private readonly pendingTexts: PendingText[] = [];
  private readonly searches = new Map<string, { query: string | null; scope?: ToolScope }>();
  constructor(execution: Execution, options: NativeOptions) {
    super(execution, options);
    this.home = join(options.directory, "claude-code");
  }
  private get subagentsEnabled(): boolean {
    return !!this.execution.agent.multi_agent?.enabled;
  }
  private get maxChildren(): number {
    return (
      this.execution.maxConcurrentSubagents ??
      this.execution.agent.multi_agent?.max_concurrent_subagents ??
      6
    );
  }
  private get webSearch() {
    return this.execution.agent.tools?.find((tool) => tool.type === "web_search");
  }
  private get outputFormat(): Options["outputFormat"] {
    const format = this.execution.agent.text?.format;
    return format?.type === "json_schema"
      ? { type: "json_schema", schema: format.schema as Record<string, unknown> }
      : undefined;
  }
  private async userMessage(messages: InputMessage[]): Promise<SDKUserMessage["message"]> {
    const content: ContentBlockParam[] = await Promise.all(
      messages
        .flatMap((message) => message.content)
        .map(async (part): Promise<ContentBlockParam> => {
          if (part.type === "input_text") return { type: "text", text: part.text };
          const image = await imageContent(
            part.image_url,
            this.abort.signal,
            this.options.mediaUrl,
          );
          return {
            type: "image",
            source: {
              type: "base64",
              media_type: z
                .enum(["image/png", "image/jpeg", "image/gif", "image/webp"])
                .parse(image.mimeType),
              data: image.data,
            },
          };
        }),
    );
    return { role: "user", content };
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
        {
          description: definition.description,
          // The PreToolUse hook stamps a subagent attribution that the schema must admit.
          inputSchema: schema.extend({ [SCOPE_KEY]: z.string().optional() }),
        },
        (args) => {
          const { [SCOPE_KEY]: scopeId, ...rest } = args as Record<string, unknown>;
          const child =
            typeof scopeId === "string"
              ? this.children.find((entry) => entry.scope.subagentId === scopeId)
              : undefined;
          return this.callTool(definition.name, rest, child?.scope);
        },
      );
    }
    const workspace: McpSdkServerConfigWithInstance = {
      type: "sdk",
      name: "workspace",
      instance,
      timeout: Math.max(1000, this.execution.deadline - Date.now()),
    };
    const input = new InputQueue();
    this.input = input;
    input.push({
      type: "user",
      message: await this.userMessage(this.execution.input),
      parent_tool_use_id: null,
      session_id: previous ?? "",
    });
    const reasoning = this.execution.agent.reasoning;
    // `none` disables extended thinking; every other level maps onto the SDK's effort
    // scale (`minimal` is its `low`). The SDK default applies when no effort is set.
    const effort =
      reasoning?.effort === "minimal"
        ? ("low" as const)
        : reasoning?.effort && reasoning.effort !== "none"
          ? reasoning.effort
          : undefined;
    // A requested summary asks the API for summarized thinking; without one the
    // model's own thinking display applies, matching the alpha behavior.
    const thinking: Options["thinking"] =
      reasoning?.effort === "none"
        ? { type: "disabled" }
        : { type: "adaptive", ...(reasoning?.summary ? { display: "summarized" as const } : {}) };
    const webSearch = this.webSearch;
    const subagents = this.subagentsEnabled;
    // One native subagent definition: it inherits the parent's tools (the workspace
    // MCP server and hosted search) and its model, and cannot nest further subagents,
    // which the Worker's delegation model does not track.
    const agents: Options["agents"] = subagents
      ? {
          "general-purpose": {
            description: "General-purpose agent for delegated subtasks of the current turn",
            prompt: `${SUBAGENT_PROMPT}${
              this.execution.agent.instructions ? `\n\n${this.execution.agent.instructions}` : ""
            }`,
            model: "inherit",
            disallowedTools: ["Task", "Agent"],
            maxTurns: 32,
          },
        }
      : undefined;
    const hooks: Options["hooks"] = subagents
      ? {
          SubagentStart: [{ hooks: [this.onSubagentStart] }],
          SubagentStop: [{ hooks: [this.onSubagentStop] }],
          PreToolUse: [{ hooks: [this.onPreToolUse] }],
        }
      : undefined;
    const session = query({
      prompt: input,
      options: {
        cwd: this.options.directory,
        model: this.execution.model,
        resume: previous,
        // Only these builtin tools exist for the model; everything else is deployment-owned MCP.
        tools: [...(webSearch ? ["WebSearch"] : []), ...(subagents ? ["Task", "Agent"] : [])],
        disallowedTools: [
          "Bash",
          "Read",
          "Write",
          "Edit",
          "Glob",
          "Grep",
          "WebFetch",
          ...(webSearch ? [] : ["WebSearch"]),
          ...(subagents ? [] : ["Task", "Agent"]),
        ],
        toolAliases: aliases,
        settingSources: [],
        strictMcpConfig: true,
        persistSession: true,
        enableFileCheckpointing: false,
        mcpServers: { workspace },
        ...(subagents ? { forwardSubagentText: true, hooks, agents } : {}),
        canUseTool: async (name, input) => {
          if (name.startsWith("mcp__workspace__"))
            return { behavior: "allow", updatedInput: input };
          if (name === "WebSearch" && webSearch)
            return {
              behavior: "allow",
              updatedInput: {
                ...input,
                ...(webSearch.allowed_domains?.length
                  ? { allowed_domains: webSearch.allowed_domains }
                  : {}),
              },
            };
          if ((name === "Task" || name === "Agent") && subagents) {
            if (
              this.children.filter((child) => child.status === "in_progress").length >=
              this.maxChildren
            )
              return { behavior: "deny", message: "Concurrent subagent limit reached" };
            return { behavior: "allow", updatedInput: input };
          }
          return {
            behavior: "deny",
            message: "Only deployment-owned workspace tools are available",
          };
        },
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append: this.execution.agent.instructions ?? "",
        },
        maxTurns: 32,
        thinking,
        ...(effort ? { effort } : {}),
        ...(this.outputFormat ? { outputFormat: this.outputFormat } : {}),
        abortController: this.abort,
        includePartialMessages: true,
        // Own the process so completion and checkpoints wait for its real exit: the
        // SDK closes its message stream before the CLI has flushed its session files.
        spawnClaudeCodeProcess: (spawnOptions) => {
          const child = spawn(spawnOptions.command, spawnOptions.args, {
            cwd: spawnOptions.cwd,
            env: spawnOptions.env,
            stdio: ["pipe", "pipe", "pipe"],
            signal: spawnOptions.signal,
            windowsHide: true,
          });
          child.stderr.setEncoding("utf8");
          child.stderr.on("data", (chunk: string) => this.options.diagnostics(chunk.trimEnd()));
          child.stderr.on("error", () => {});
          this.exited = new Promise((resolve) => {
            child.once("exit", () => resolve());
            child.once("error", () => resolve());
          });
          return child;
        },
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
      },
    });
    this.query = session;
    this.run(async () => {
      let completed = false;
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
        if (message.type === "system" && message.subtype === "task_started") {
          if (message.tool_use_id) {
            const child = this.child({ taskToolUseId: message.tool_use_id }, message.task_id);
            child.name ??= message.subagent_type ?? null;
            child.instructions ??= message.description;
            this.announce(child);
          }
        } else if (message.type === "system" && message.subtype === "task_notification") {
          const child = this.children.find(
            (entry) =>
              entry.taskId === message.task_id ||
              (message.tool_use_id !== undefined && entry.taskToolUseId === message.tool_use_id),
          );
          if (child)
            this.finish(
              child,
              message.status === "completed"
                ? "completed"
                : message.status === "stopped"
                  ? "cancelled"
                  : "failed",
              message.summary,
            );
        } else if (message.type === "user" && !("isReplay" in message)) {
          this.acceptUser(message);
        } else if (message.type === "assistant") {
          this.acceptAssistant(
            message.message.id,
            message.message.content,
            message.parent_tool_use_id,
          );
        } else if (message.type === "stream_event") {
          this.acceptStream(message.event, message.parent_tool_use_id);
        } else if (message.type === "result") {
          this.recordUsage(message);
          // Queued input and running native subagents keep the session alive: the CLI
          // wakes the main thread again when a background task finishes.
          const pendingWork =
            (message.queued_turn_count ?? 0) > 0 ||
            this.children.some((child) => child.status === "in_progress");
          // This CLI release gives up on structured output silently: the turn's final
          // result reads as a success that carries no `structured_output`.
          const structuredOutputMissing =
            message.subtype === "error_max_structured_output_retries" ||
            (!pendingWork &&
              this.outputFormat !== undefined &&
              message.subtype === "success" &&
              !message.is_error &&
              message.structured_output === undefined);
          const error =
            claudeTurnError(message) ?? (structuredOutputMissing ? "internal_error" : undefined);
          if (error) {
            if (this.cancelling) return;
            if (structuredOutputMissing)
              this.options.diagnostics(
                "claude-code gave up on structured output: the model never produced a reply matching agent.text.format",
              );
            this.options.diagnostics(
              `claude-code turn failed (${error}): ${JSON.stringify({
                subtype: message.subtype,
                terminal_reason: message.terminal_reason,
                status: message.subtype === "success" ? message.api_error_status : undefined,
                errors: message.subtype === "success" ? [message.result] : message.errors,
              })}`,
            );
            this.lifecycle.fail(error);
            input.close();
            return;
          }
          if (pendingWork) continue;
          this.finalize(message);
          completed = true;
          this.finished = true;
          input.close();
        }
      }
      // The turn is exposed as complete only once the CLI has written its history.
      await this.awaitExit();
      if (this.cancelling) return;
      if (!completed) throw new Error("Claude Code exited without a completed result");
    });
  }
  private async awaitExit(): Promise<void> {
    if (!this.exited) return;
    const timer = new AbortController();
    await Promise.race([
      this.exited,
      delay(EXIT_GRACE_MS, undefined, { signal: timer.signal }).catch(() => {}),
    ]).finally(() => timer.abort());
  }
  /** Register or merge a native subagent identified by whichever signal arrived first. */
  private child(key: { agentId?: string; taskToolUseId?: string }, taskId?: string): Child {
    let child = this.children.find(
      (entry) =>
        (key.agentId !== undefined && entry.agentId === key.agentId) ||
        (key.taskToolUseId !== undefined && entry.taskToolUseId === key.taskToolUseId) ||
        (taskId !== undefined && entry.taskId === taskId),
    );
    if (!child) {
      // A task and its hook can arrive under different keys before either is linked;
      // adopt the newest unlinked child rather than announcing a second one.
      child = this.children.findLast(
        (entry) =>
          entry.status === "in_progress" &&
          ((key.agentId !== undefined && entry.agentId === undefined) ||
            (key.taskToolUseId !== undefined && entry.taskToolUseId === undefined)),
      );
    }
    if (!child) {
      child = {
        scope: {
          subagentId: `subagent_${crypto.randomUUID().replaceAll("-", "")}`,
          turnId: `turn_${crypto.randomUUID().replaceAll("-", "")}`,
        },
        name: null,
        instructions: null,
        openedAt: Math.floor(Date.now() / 1000),
        status: "in_progress",
        announced: false,
        textForwarded: false,
      };
      this.children.push(child);
    }
    if (key.agentId !== undefined) child.agentId ??= key.agentId;
    if (key.taskToolUseId !== undefined) child.taskToolUseId ??= key.taskToolUseId;
    if (taskId !== undefined) child.taskId ??= taskId;
    return child;
  }
  private announce(child: Child): void {
    if (child.announced) return;
    child.announced = true;
    this.emit({
      type: "subagent",
      id: child.scope.subagentId,
      parentId: null,
      name: child.name,
      instructions: child.instructions,
      status: "active",
      openedAt: child.openedAt,
    });
    this.emit({
      type: "subagent_turn",
      id: child.scope.turnId,
      subagentId: child.scope.subagentId,
      status: "in_progress",
      startedAt: child.openedAt,
      completedAt: null,
    });
  }
  private finish(child: Child, status: Child["status"], lastText?: string): void {
    if (child.status !== "in_progress") return;
    this.announce(child);
    child.status = status;
    this.flushTexts((entry) => entry.scope?.subagentId === child.scope.subagentId, "final_answer");
    if (!child.textForwarded && lastText)
      this.emit({
        type: "text",
        id: `${child.scope.turnId}:summary`,
        text: lastText,
        phase: "final_answer",
        ...child.scope,
      });
    this.emit({
      type: "subagent_turn",
      id: child.scope.turnId,
      subagentId: child.scope.subagentId,
      status,
      startedAt: child.openedAt,
      completedAt: Math.floor(Date.now() / 1000),
    });
    this.emit({
      type: "subagent",
      id: child.scope.subagentId,
      parentId: null,
      name: child.name,
      instructions: child.instructions,
      status: "closed",
      openedAt: child.openedAt,
    });
  }
  private readonly onSubagentStart: HookCallback = async (input, toolUseID) => {
    if (input.hook_event_name === "SubagentStart") {
      const child = this.child({ agentId: input.agent_id, taskToolUseId: toolUseID });
      child.name ??= input.agent_type;
      this.announce(child);
    }
    return {};
  };
  private readonly onSubagentStop: HookCallback = async (input) => {
    if (input.hook_event_name === "SubagentStop") {
      const child = this.children.find((entry) => entry.agentId === input.agent_id);
      if (child) this.finish(child, "completed", input.last_assistant_message);
    }
    return {};
  };
  private readonly onPreToolUse: HookCallback = async (input) => {
    if (input.hook_event_name !== "PreToolUse" || !input.tool_name.startsWith("mcp__workspace__"))
      return {};
    const child =
      (input.agent_id !== undefined
        ? this.children.find((entry) => entry.agentId === input.agent_id)
        : undefined) ?? this.innerToolUses.get(input.tool_use_id);
    if (!child) return {};
    const toolInput = input.tool_input;
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        updatedInput: {
          ...(toolInput && typeof toolInput === "object"
            ? (toolInput as Record<string, unknown>)
            : {}),
          [SCOPE_KEY]: child.scope.subagentId,
        },
      },
    };
  };
  private scopeOf(parentToolUseId: string | null): ToolScope | undefined {
    if (!parentToolUseId) return undefined;
    return this.child({ taskToolUseId: parentToolUseId }).scope;
  }
  /** Text is announced once its role is known: commentary before a tool call, the answer otherwise. */
  private flushTexts(
    filter: (entry: PendingText) => boolean,
    phase: "commentary" | "final_answer",
  ): void {
    for (const entry of this.pendingTexts.filter(filter)) {
      this.pendingTexts.splice(this.pendingTexts.indexOf(entry), 1);
      this.emit({ type: "text", id: entry.id, text: entry.text, phase, ...entry.scope });
    }
  }
  private acceptAssistant(
    messageId: string,
    content: BetaContentBlock[],
    parentToolUseId: string | null,
  ): void {
    const scope = this.scopeOf(parentToolUseId);
    const sameScope = (entry: PendingText) => entry.scope?.subagentId === scope?.subagentId;
    // A new assistant message means the previous one was followed by a tool round.
    this.flushTexts((entry) => sameScope(entry) && entry.messageId !== messageId, "commentary");
    if (content.some((part) => part.type === "tool_use" || part.type === "server_tool_use"))
      this.flushTexts((entry) => sameScope(entry) && entry.messageId === messageId, "commentary");
    for (const [index, part] of content.entries()) {
      const id = `${messageId}:${index}`;
      if (part.type === "text") {
        if (scope) {
          const child = this.child({ taskToolUseId: parentToolUseId ?? undefined });
          child.textForwarded = true;
        }
        if (this.outputFormat && !scope)
          this.emit({ type: "text", id, text: part.text, phase: "commentary" });
        else this.pendingTexts.push({ id, text: part.text, messageId, scope });
      } else if (part.type === "thinking")
        this.emit({
          type: "reasoning",
          id,
          summary: [part.thinking],
          status: "completed",
          ...scope,
        });
      else if (part.type === "tool_use") {
        if (scope)
          this.innerToolUses.set(
            part.id,
            this.child({ taskToolUseId: parentToolUseId ?? undefined }),
          );
        if (part.name === "WebSearch") this.searchStarted(part.id, part.input, scope);
      } else if (part.type === "server_tool_use" && part.name === "web_search") {
        this.searchStarted(part.id, part.input, scope);
      } else if (part.type === "web_search_tool_result") {
        this.searchFinished(part.tool_use_id, Array.isArray(part.content), scope);
      }
    }
  }
  private searchStarted(id: string, input: unknown, scope?: ToolScope): void {
    const query =
      input && typeof input === "object" && typeof (input as { query?: unknown }).query === "string"
        ? (input as { query: string }).query
        : null;
    this.searches.set(id, { query, scope });
    this.emit({
      type: "web_search",
      id,
      action: { type: "search", query, queries: null },
      status: "in_progress",
      ...scope,
    });
  }
  private searchFinished(id: string, success: boolean, scope?: ToolScope): void {
    const search = this.searches.get(id);
    if (!search) return;
    this.searches.delete(id);
    this.emit({
      type: "web_search",
      id,
      action: { type: "search", query: search.query, queries: null },
      status: success ? "completed" : "incomplete",
      ...scope,
    });
  }
  /** Tool results the CLI adds to the conversation close the searches they answer. */
  private acceptUser(message: Extract<SDKMessage, { type: "user" }>): void {
    const content = message.message.content;
    if (typeof content === "string") return;
    for (const part of content)
      if (part.type === "tool_result" && this.searches.has(part.tool_use_id))
        this.searchFinished(
          part.tool_use_id,
          !part.is_error,
          this.scopeOf(message.parent_tool_use_id),
        );
  }
  private readonly streamMessage = new Map<string, string>();
  private acceptStream(
    event: Extract<SDKMessage, { type: "stream_event" }>["event"],
    parentToolUseId: string | null,
  ): void {
    const scope = this.scopeOf(parentToolUseId);
    const key = parentToolUseId ?? "root";
    if (event.type === "message_start") {
      this.streamMessage.set(key, event.message.id);
      return;
    }
    const messageId = this.streamMessage.get(key);
    if (!messageId) return;
    if (event.type === "content_block_start" && event.content_block.type === "thinking") {
      this.emit({
        type: "reasoning",
        id: `${messageId}:${event.index}`,
        summary: [],
        status: "in_progress",
        ...scope,
      });
      this.emit({
        type: "reasoning_part",
        id: `${messageId}:${event.index}`,
        summaryIndex: 0,
        text: event.content_block.thinking,
        ...scope,
      });
    }
    if (event.type === "content_block_delta" && event.delta.type === "thinking_delta")
      this.emit({
        type: "reasoning_delta",
        id: `${messageId}:${event.index}`,
        summaryIndex: 0,
        text: event.delta.thinking,
        ...scope,
      });
    if (event.type === "content_block_delta" && event.delta.type === "text_delta")
      this.emit({
        type: "delta",
        id: `${messageId}:${event.index}`,
        text: event.delta.text,
        ...scope,
      });
  }
  private recordUsage(message: SDKResultMessage): void {
    this.settleResult?.();
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
          reasoning_tokens: models.reduce((sum, model) => sum + (model.thinkingTokens ?? 0), 0),
        },
      },
    });
  }
  private finalize(message: SDKResultMessage): void {
    for (const child of this.children)
      if (child.status === "in_progress") this.finish(child, "completed");
    this.flushTexts(() => true, "final_answer");
    if (message.subtype === "success" && message.structured_output !== undefined)
      this.emit({
        type: "text",
        id: `structured:${this.execution.turnId}`,
        text: JSON.stringify(message.structured_output),
        phase: "final_answer",
      });
  }
  protected override async steer(messages: InputMessage[]): Promise<void> {
    const input = this.input;
    if (!input || this.finished || input.closed)
      throw new ApiError(409, "command_rejected", "Turn has already finished");
    const message = await this.userMessage(messages);
    if (this.finished || input.closed)
      throw new ApiError(409, "command_rejected", "Turn has already finished");
    input.push({
      type: "user",
      message,
      parent_tool_use_id: null,
      session_id: this.sessionId,
      priority: "now",
    });
  }
  /** Interrupt the native turn and wait for its result so cancelled turns still report usage. */
  protected override async interruptRuntime(): Promise<void> {
    const session = this.query;
    if (!session || this.finished || !this.input || this.input.closed) return;
    const settled = new Promise<void>((resolve) => {
      this.settleResult = resolve;
    });
    await session.interrupt().catch((error) => {
      this.options.diagnostics(`claude-code interrupt: ${String(error)}`);
    });
    await Promise.race([settled, delay(INTERRUPT_GRACE_MS)]);
    this.finished = true;
    this.input.close();
  }
  protected async closeRuntime(): Promise<void> {
    this.finished = true;
    this.input?.close();
    this.query?.close();
    // The SDK ends input and force-kills after a short grace; a checkpoint taken
    // after this must see the flushed session files, so wait for the exit.
    await this.awaitExit();
    await this.workspaceServer?.close();
  }
}
