import { type ChildProcess, spawn } from "node:child_process";
import { join } from "node:path";

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
import {
  CONNECTION_FAILURE,
  type Execution,
  type InputMessage,
  io,
  workspaceTools,
} from "cf-open-agents-api";
import { Effect } from "effect";
import { z } from "zod";

import {
  closeSubagent,
  closeSubagentTurn,
  nowSeconds,
  openSubagent,
  openSubagentTurn,
  randomId,
  usageEvent,
} from "./events.js";
import { type NativeOptions, ToolJob, type ToolScope } from "./job.js";
import {
  CommandRejected,
  describeFailure,
  ExecutionStopped,
  statusToTurnCode,
  type TurnErrorCode,
  Wake,
  within,
} from "./lifecycle.js";
import { imageContent } from "./media.js";
import { exitedWithin, NativeStartupFailed, NativeTurnFailed } from "./process.js";

/** Tool input key that carries a subagent attribution from the PreToolUse hook to the MCP handler. */
const SCOPE_KEY = "__cf_scope";
/** Time allowed for an interrupted turn to report its result, so cancelled turns still carry usage. */
const INTERRUPT_GRACE = "10 seconds";
/** Time allowed for the CLI to exit and flush its session files once its input ends. */
const EXIT_GRACE = "5 seconds";

const RUNTIME = "claude-code";
/** A native task's terminal status as the public subagent turn status. */
function taskStatus(status: string): "completed" | "cancelled" | "failed" {
  if (status === "completed") return "completed";
  return status === "stopped" ? "cancelled" : "failed";
}
const SUBAGENT_PROMPT =
  "You are a subagent working on one delegated subtask for the main agent. Complete the subtask with the tools available and reply with a concise report of the result.";

/** Streaming-input prompt: stays open for the life of the turn so input can be folded in. */
class InputQueue implements AsyncIterable<SDKUserMessage> {
  private readonly items: SDKUserMessage[] = [];
  private wake?: () => void;
  closed = false;
  /** The queue closes with the turn; a push after that has nowhere to go. */
  push(message: SDKUserMessage): void {
    if (this.closed) throw new ExecutionStopped();
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

/**
 * `none` disables extended thinking; every other level maps onto the SDK's effort
 * scale (`minimal` is its `low`). The SDK default applies when no effort is set. A
 * requested summary asks the API for summarized thinking; without one the model's
 * own thinking display applies, matching the alpha behavior.
 */
function reasoningOptions(reasoning: Execution["agent"]["reasoning"]): {
  effort: Options["effort"];
  thinking: Options["thinking"];
} {
  const level = reasoning?.effort;
  if (level === "none") return { effort: undefined, thinking: { type: "disabled" } };
  const thinking: Options["thinking"] = {
    type: "adaptive",
    ...(reasoning?.summary ? { display: "summarized" as const } : {}),
  };
  if (!level) return { effort: undefined, thinking };
  return { effort: level === "minimal" ? "low" : level, thinking };
}
/**
 * The CLI resolves the `haiku`, `sonnet` and `opus` aliases a subagent may ask for
 * through these variables; each tier is a gateway name, else the session's model.
 * `ANTHROPIC_DEFAULT_HAIKU_MODEL` is also the CLI's small-fast model for its own
 * helper calls (title, quota and prompt-hook probes, which
 * `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` suppresses), so `tiers.haiku` must
 * name a preset that accepts the same protocol as the session's model.
 */
export function tierEnv(
  execution: Pick<Execution, "model" | "tiers">,
): Record<
  | "ANTHROPIC_DEFAULT_HAIKU_MODEL"
  | "ANTHROPIC_DEFAULT_SONNET_MODEL"
  | "ANTHROPIC_DEFAULT_OPUS_MODEL",
  string
> {
  const { model, tiers } = execution;
  return {
    ANTHROPIC_DEFAULT_HAIKU_MODEL: tiers?.haiku ?? model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: tiers?.sonnet ?? model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: tiers?.opus ?? model,
  };
}
/** Map a Claude Code result to the public turn error code; native detail goes to diagnostics. */
export function claudeTurnError(result: SDKResultMessage): TurnErrorCode | undefined {
  if (result.subtype === "success" && !result.is_error) return undefined;
  const status = result.subtype === "success" ? result.api_error_status : undefined;
  const errors = result.subtype === "success" ? [result.result] : result.errors;
  const text = errors.join("\n").toLowerCase();
  if (/prompt is too long|context window|context_length/.test(text))
    return "context_length_exceeded";
  if (/overloaded/.test(text)) return "server_overloaded";
  // `api_error_status` is an answer from the upstream, so it decides before the
  // transport phrases do: a 429 whose body mentions a reset connection is a rate
  // limit, not a connection that never happened. The phrases decide only when the
  // result carries no status, or one that maps to nothing.
  const fromStatus = statusToTurnCode(status ?? undefined);
  if (fromStatus) return fromStatus;
  if (CONNECTION_FAILURE.test(text)) return "connection_failed";
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

/**
 * Aligns the ids of completed blocks with the streamed ones. With partial messages
 * the SDK delivers one `assistant` message per completed block, all under the same
 * message id with a single-element `content`, and drops a text block that stayed
 * empty (`0 thinking, 1 text(""), 2 text("Calling."), 3 tool_use` arrive as three
 * messages). Each part therefore takes the next stream block of its type that has
 * not been consumed, skipping text blocks that received no text, so `text` and
 * `reasoning` carry the id their deltas were streamed under. Without a stream
 * record (no partial messages, a full `content` array) the position is the index.
 */
export class StreamBlocks {
  private readonly byMessage = new Map<
    string,
    { index: number; type: string; received: boolean; consumed: boolean }[]
  >();
  started(messageId: string, index: number, type: string): void {
    const blocks = this.byMessage.get(messageId) ?? [];
    blocks.push({ index, type, received: false, consumed: false });
    this.byMessage.set(messageId, blocks);
  }
  received(messageId: string, index: number): void {
    const block = this.byMessage.get(messageId)?.find((entry) => entry.index === index);
    if (block) block.received = true;
  }
  assign(messageId: string, type: string, position: number): number {
    const blocks = this.byMessage.get(messageId);
    if (!blocks) return position;
    const block = blocks.find(
      (entry) => !entry.consumed && entry.type === type && (type !== "text" || entry.received),
    );
    if (!block) return position;
    block.consumed = true;
    return block.index;
  }
  clear(): void {
    this.byMessage.clear();
  }
}

export class ClaudeCodeJob extends ToolJob {
  readonly home: string;
  private query?: Query;
  private input?: InputQueue;
  private workspaceServer?: McpServer;
  /** The turn produced its terminal result; late input belongs to the next public turn. */
  private finished = false;
  /** Fires when a result message lands; an interrupt waits on it, bounded, for the turn's usage. */
  private readonly resultSettled = new Wake();
  /** The CLI process; the SDK ends its message stream before the process has exited. */
  private cli?: ChildProcess;
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
      ? { type: "json_schema", schema: format.schema }
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
        throw new NativeStartupFailed({
          runtime: RUNTIME,
          cause: `Tool ${definition.name} parameters must describe an object`,
        });
      instance.registerTool(
        definition.name,
        {
          description: definition.description,
          // The PreToolUse hook stamps a subagent attribution that the schema must admit.
          inputSchema: schema.extend({ [SCOPE_KEY]: z.string().optional() }),
        },
        (args) => {
          const { [SCOPE_KEY]: scopeId, ...rest } = args;
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
    const { effort, thinking } = reasoningOptions(this.execution.agent.reasoning);
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
        canUseTool: this.canUseTool,
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
          this.cli = child;
          // The job's resources terminate the CLI if the SDK's own shutdown leaves it running.
          void this.own(child, EXIT_GRACE).catch(() => {});
          return child;
        },
        env: {
          PATH: process.env.PATH,
          HOME: this.home,
          CLAUDE_CONFIG_DIR: this.home,
          ANTHROPIC_API_KEY: "private-worker-gateway",
          ANTHROPIC_BASE_URL: this.options.modelBaseUrl.replace(/\/v1\/?$/, ""),
          ...tierEnv(this.execution),
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        },
      },
    });
    this.query = session;
    this.run(
      Effect.gen(this, function* () {
        const outcome = yield* io("claude.messages", () => this.consume(session, input));
        if (outcome === "abandoned") return;
        // The turn is exposed as complete only once the CLI has written its history.
        yield* this.cliExited();
        if (this.cancelling) return;
        if (outcome !== "completed")
          return yield* new NativeTurnFailed({
            runtime: RUNTIME,
            code: "native_harness_failed",
            reason: "Claude Code exited without a completed result",
          });
      }),
    );
  }
  /**
   * Consume the SDK's message stream until it ends; the job's abort ends it early.
   * `abandoned` means the turn failed or was cancelled and the CLI's exit is not
   * awaited; `incomplete` means the stream ended without the turn's result.
   */
  private async consume(
    session: Query,
    input: InputQueue,
  ): Promise<"completed" | "incomplete" | "abandoned"> {
    let completed = false;
    for await (const message of session) {
      if (message.session_id) this.sessionId = message.session_id;
      if (message.type === "system") this.acceptSystem(message);
      else if (message.type === "user" && !("isReplay" in message)) this.acceptUser(message);
      else if (message.type === "assistant")
        this.acceptAssistant(
          message.message.id,
          message.message.content,
          message.parent_tool_use_id,
        );
      else if (message.type === "stream_event")
        this.acceptStream(message.event, message.parent_tool_use_id);
      else if (message.type === "result") {
        // The stream is drained to its end either way; only a failed turn stops reading.
        const outcome = this.acceptResult(message, input);
        if (outcome === "abandoned") return outcome;
        if (outcome === "completed") completed = true;
      }
    }
    return completed ? "completed" : "incomplete";
  }
  /** Session bookkeeping: the workspace server must be up, and native tasks map onto children. */
  private acceptSystem(message: Extract<SDKMessage, { type: "system" }>): void {
    if (
      message.subtype === "init" &&
      !message.mcp_servers.some(
        (server) => server.name === "workspace" && server.status === "connected",
      )
    )
      throw new NativeStartupFailed({
        runtime: RUNTIME,
        cause: "Workspace MCP server failed to connect",
      });
    if (message.subtype === "task_started" && message.tool_use_id) {
      const child = this.child({ taskToolUseId: message.tool_use_id }, message.task_id);
      child.name ??= message.subagent_type ?? null;
      child.instructions ??= message.description;
      this.announce(child);
    }
    if (message.subtype === "task_notification") {
      const child = this.children.find(
        (entry) =>
          entry.taskId === message.task_id ||
          (message.tool_use_id !== undefined && entry.taskToolUseId === message.tool_use_id),
      );
      if (child) this.finish(child, taskStatus(message.status), message.summary);
    }
  }
  /**
   * The turn's result: `abandoned` when it failed or was cancelled (the CLI's exit is
   * not awaited), `completed` once the turn and its native subagents are done, and
   * nothing while queued input or a running subagent keeps the session alive.
   */
  private acceptResult(
    message: SDKResultMessage,
    input: InputQueue,
  ): "completed" | "abandoned" | undefined {
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
      if (this.cancelling) return "abandoned";
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
      return "abandoned";
    }
    if (pendingWork) return undefined;
    // Message ids are unique to one turn; the per-message bookkeeping ends with it.
    this.streamMessage.clear();
    this.blocks.clear();
    this.finalize(message);
    this.finished = true;
    input.close();
    return "completed";
  }
  /** Waits, up to the exit grace, for the CLI to exit on its own after its input ended. */
  private cliExited(): Effect.Effect<void> {
    const cli = this.cli;
    return cli ? exitedWithin(cli, EXIT_GRACE).pipe(Effect.asVoid) : Effect.void;
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
        scope: { subagentId: randomId("subagent"), turnId: randomId("turn") },
        name: null,
        instructions: null,
        openedAt: nowSeconds(),
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
    this.emit(
      openSubagent({
        id: child.scope.subagentId,
        name: child.name,
        instructions: child.instructions,
        openedAt: child.openedAt,
      }),
    );
    this.emit(
      openSubagentTurn({
        id: child.scope.turnId,
        subagentId: child.scope.subagentId,
        startedAt: child.openedAt,
      }),
    );
  }
  private finish(
    child: Child,
    status: Exclude<Child["status"], "in_progress">,
    lastText?: string,
  ): void {
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
    this.emit(
      closeSubagentTurn({
        id: child.scope.turnId,
        subagentId: child.scope.subagentId,
        status,
        startedAt: child.openedAt,
      }),
    );
    this.emit(
      closeSubagent({
        id: child.scope.subagentId,
        name: child.name,
        instructions: child.instructions,
        openedAt: child.openedAt,
      }),
    );
  }
  /** Only deployment-owned workspace tools, hosted search and (bounded) native subagents may run. */
  private readonly canUseTool: NonNullable<Options["canUseTool"]> = async (name, toolInput) => {
    if (name.startsWith("mcp__workspace__")) return { behavior: "allow", updatedInput: toolInput };
    const webSearch = this.webSearch;
    if (name === "WebSearch" && webSearch)
      return {
        behavior: "allow",
        updatedInput: {
          ...toolInput,
          ...(webSearch.allowed_domains?.length
            ? { allowed_domains: webSearch.allowed_domains }
            : {}),
        },
      };
    if ((name === "Task" || name === "Agent") && this.subagentsEnabled) {
      const running = this.children.filter((child) => child.status === "in_progress").length;
      if (running >= this.maxChildren)
        return { behavior: "deny", message: "Concurrent subagent limit reached" };
      return { behavior: "allow", updatedInput: toolInput };
    }
    return { behavior: "deny", message: "Only deployment-owned workspace tools are available" };
  };
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
    for (const [position, part] of content.entries()) {
      const id = `${messageId}:${this.blocks.assign(messageId, part.type, position)}`;
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
    const searchQuery =
      input && typeof input === "object" && typeof (input as { query?: unknown }).query === "string"
        ? (input as { query: string }).query
        : null;
    this.searches.set(id, { query: searchQuery, scope });
    this.emit({
      type: "web_search",
      id,
      action: { type: "search", query: searchQuery, queries: null },
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
  /** Streamed message id per scope (`root` or the parent tool use), set by `message_start`. */
  private readonly streamMessage = new Map<string, string>();
  /** Block positions the stream announced per message id, consumed by `acceptAssistant`. */
  private readonly blocks = new StreamBlocks();
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
    if (event.type === "content_block_start")
      this.blocks.started(messageId, event.index, event.content_block.type);
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
    if (event.type === "content_block_delta" && event.delta.type === "thinking_delta") {
      this.blocks.received(messageId, event.index);
      this.emit({
        type: "reasoning_delta",
        id: `${messageId}:${event.index}`,
        summaryIndex: 0,
        text: event.delta.thinking,
        ...scope,
      });
    }
    // An empty delta carries nothing, and the CLI drops a text block that stays empty.
    if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
      if (!event.delta.text) return;
      this.blocks.received(messageId, event.index);
      this.emit({
        type: "delta",
        id: `${messageId}:${event.index}`,
        text: event.delta.text,
        ...scope,
      });
    }
  }
  private recordUsage(message: SDKResultMessage): void {
    this.resultSettled.notify();
    const models = Object.values(message.modelUsage);
    const input = models.reduce(
      (sum, model) =>
        sum + model.inputTokens + model.cacheReadInputTokens + model.cacheCreationInputTokens,
      0,
    );
    const output = models.reduce((sum, model) => sum + model.outputTokens, 0);
    this.emit(
      usageEvent(`usage:${this.execution.turnId}`, {
        input,
        output,
        cached: models.reduce((sum, model) => sum + model.cacheReadInputTokens, 0),
        reasoning: models.reduce((sum, model) => sum + (model.thinkingTokens ?? 0), 0),
      }),
    );
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
  protected override steer(messages: InputMessage[]) {
    return Effect.gen(this, function* () {
      const finished = () => new CommandRejected({ reason: "Turn has already finished" });
      const input = this.input;
      if (!input || this.finished || input.closed) return yield* finished();
      const message = yield* io("claude.input", () => this.userMessage(messages));
      if (this.finished || input.closed) return yield* finished();
      input.push({
        type: "user",
        message,
        parent_tool_use_id: null,
        session_id: this.sessionId,
        priority: "now",
      });
    });
  }
  /**
   * Interrupt the native turn and wait for its result so cancelled turns still report
   * usage. The control request and the result it should produce share one grace: the
   * SDK's request takes no signal and settles only when the query closes, so a CLI
   * that never answers cannot hold the stop.
   */
  protected override interruptRuntime() {
    return Effect.gen(this, function* () {
      const session = this.query;
      const input = this.input;
      if (!session || this.finished || !input || input.closed) return;
      // Captured before the interrupt: a result that lands during it still counts.
      const settled = this.resultSettled.wait();
      const interrupted = io("claude.interrupt", () => session.interrupt()).pipe(
        Effect.catchAll((error) =>
          Effect.sync(() =>
            this.options.diagnostics(`claude-code interrupt: ${describeFailure(error)}`),
          ),
        ),
      );
      yield* within(interrupted.pipe(Effect.zipRight(settled)), INTERRUPT_GRACE);
      this.finished = true;
      input.close();
    });
  }
  protected closeRuntime() {
    return Effect.gen(this, function* () {
      this.finished = true;
      this.input?.close();
      this.query?.close();
      // The SDK ends input and force-kills after a short grace; a checkpoint taken
      // after this must see the flushed session files, so wait for the exit.
      yield* this.cliExited();
      const workspace = this.workspaceServer;
      if (workspace) yield* io("claude.workspace.close", () => workspace.close());
    });
  }
}
