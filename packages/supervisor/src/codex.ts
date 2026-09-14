import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Execution, RuntimeBatch, RuntimeCommand, RuntimeEvent } from "cf-open-agents-api";
import {
  ApiError,
  io,
  type JsonValue,
  programmaticTool,
  runPromise,
  runSync,
  workspaceTools,
} from "cf-open-agents-api";
import { Deferred, Effect, Ref } from "effect";
import { z } from "zod";
import { capture, type NativeBundle, restore } from "./checkpoint.js";
import { DELEGATION_TOOLS, type DelegationOptions, Delegations } from "./delegation.js";
import { AppServer, RpcError, type RpcMessage } from "./json-rpc.js";
import {
  describeFailure,
  JobLifecycle,
  Operations,
  once,
  type TurnErrorCode,
} from "./lifecycle.js";
import { codeEnabled, executeCode, functionArguments } from "./programmatic.js";
import { executeWorkspace } from "./workspace.js";

const threadResponse = z.object({ thread: z.object({ id: z.string() }) });
const turnResponse = z.object({ turn: z.object({ id: z.string() }) });
const toolCall = z.object({ callId: z.string(), tool: z.string(), arguments: z.json() });
/** EXPERIMENTAL `item/tool/requestUserInput` server request (ToolRequestUserInputParams). */
const userInputRequest = z.object({
  itemId: z.string(),
  questions: z.array(
    z.object({
      id: z.string(),
      header: z.string(),
      question: z.string(),
      options: z
        .array(z.object({ label: z.string(), description: z.string() }))
        .nullable()
        .optional(),
    }),
  ),
});
/**
 * Translate Codex's `TurnError.codexErrorInfo` (a camelCase enum string, or a
 * single-key object such as `{ httpConnectionFailed: { httpStatusCode } }`) to the
 * public `SessionTurnError.code` vocabulary. Unknown variants are `internal_error`.
 */
export function turnErrorCode(info: unknown, message = ""): TurnErrorCode {
  const variant =
    typeof info === "string"
      ? info
      : info && typeof info === "object"
        ? Object.keys(info)[0]
        : undefined;
  const detail =
    info && typeof info === "object" && variant
      ? (info as Record<string, { httpStatusCode?: number | null } | undefined>)[variant]
      : undefined;
  switch (variant) {
    case "contextWindowExceeded":
      return "context_length_exceeded";
    case "sessionBudgetExceeded":
      return "session_budget_exceeded";
    case "usageLimitExceeded":
      return "usage_limit_exceeded";
    case "rateLimitExceeded":
      return "rate_limit_exceeded";
    case "serverOverloaded":
      return "server_overloaded";
    case "cyberPolicy":
    case "misalignmentPolicyViolation":
      return "cyber_policy";
    case "httpConnectionFailed":
    case "responseStreamConnectionFailed":
    case "responseStreamDisconnected":
    case "responseTooManyFailedAttempts":
      // Codex reports the upstream HTTP status it gave up on; that status is
      // more informative than the transport wrapper (e.g. 429 after retries).
      return httpStatusCode(detail?.httpStatusCode ?? undefined) ?? "connection_failed";
    case "internalServerError":
      return "server_error";
    case "unauthorized":
      return "authentication_error";
    case "badRequest":
      return "invalid_request";
    case "sandboxError":
      return "sandbox_error";
    case "activeTurnNotSteerable":
      return "active_turn_not_steerable";
    default:
      // Codex 0.154.0 classifies most provider HTTP failures as `other` and keeps
      // the status and upstream body in the message; recover the public code from it.
      return messageErrorCode(message) ?? "internal_error";
  }
}
function httpStatusCode(status: number | undefined): TurnErrorCode | undefined {
  if (status === undefined) return undefined;
  if (status === 401 || status === 403) return "authentication_error";
  if (status === 404) return "resource_not_found";
  if (status === 429) return "rate_limit_exceeded";
  if (status === 503 || status === 529) return "server_overloaded";
  if (status >= 500) return "server_error";
  if (status === 400 || status === 422) return "invalid_request";
  return undefined;
}
function messageErrorCode(message: string): TurnErrorCode | undefined {
  if (/context_length_exceeded|context[ _]window|exceeds the context/i.test(message))
    return "context_length_exceeded";
  if (/insufficient_quota|usage_limit_reached|usage_not_included/i.test(message))
    return "usage_limit_exceeded";
  const status = /\bstatus:?\s*(\d{3})\b/i.exec(message)?.[1];
  return status ? httpStatusCode(Number(status)) : undefined;
}
const tokenUsage = z.object({
  inputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  reasoningOutputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
});
const completedItem = z.object({
  item: z.discriminatedUnion("type", [
    z.object({
      type: z.literal("mcpToolCall"),
      id: z.string(),
      server: z.string(),
      tool: z.string(),
      status: z.string(),
      arguments: z.json(),
      result: z.json(),
      error: z.json(),
    }),
    z.object({
      type: z.literal("agentMessage"),
      id: z.string(),
      text: z.string(),
      phase: z.enum(["commentary", "final_answer"]).nullable().optional(),
    }),
    z.object({
      type: z.literal("commandExecution"),
      id: z.string(),
      command: z.string(),
      aggregatedOutput: z.string().nullable().optional(),
      exitCode: z.number().nullable().optional(),
      cwd: z.string().nullable().optional(),
      durationMs: z.number().nullable().optional(),
      status: z.string().optional(),
    }),
  ]),
});
const childStateSchema = z.object({
  parent: z.string(),
  name: z.string().nullable(),
  instructions: z.string().nullable(),
  openedAt: z.number(),
  closed: z.boolean(),
  active: z.boolean(),
  turnId: z.string().optional(),
});
type ChildState = z.infer<typeof childStateSchema>;
const childId = (id: string) => `subagent_${id.replaceAll("-", "")}`;
const childTurnId = (id: string) => `turn_${id.replaceAll("-", "")}`;

export interface CodexOptions {
  binary: string;
  directory: string;
  modelBaseUrl: string;
  sandboxUrl: string;
  diagnostics: (line: string) => void;
  programmaticUrl?: string;
  delegateUrl?: string;
  /** Bounds for delegate round trips; tests shorten them. */
  delegationTimeouts?: DelegationOptions["timeouts"];
  /**
   * Deployment-owned additions to the generated Codex config: extra `[features]`
   * flags and `[model_providers.gateway]` keys such as retry counts. Values are
   * written as TOML literals; they cannot change the provider URL or auth.
   */
  codexConfig?: {
    features?: Record<string, boolean>;
    provider?: Record<string, string | number | boolean>;
  };
}
const RESERVED_PROVIDER_KEYS = new Set(["name", "base_url", "wire_api", "requires_openai_auth"]);
const tomlLines = (
  entries: Record<string, string | number | boolean> | undefined,
  reserved = new Set<string>(),
) =>
  Object.entries(entries ?? {})
    .filter(([key]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && !reserved.has(key))
    .map(([key, value]) => `${key} = ${JSON.stringify(value)}`);

/** One instance per attempt. Workspace I/O goes through the remote environment. */
export class CodexJob {
  private server?: AppServer;
  private threadId = "";
  private nativeTurnId = "";
  private readonly children = new Map<string, ChildState>();
  private rootOutcome?: "completed" | "cancelled";
  private cancelRequested = false;
  private readonly usageByTurn = new Map<
    string,
    { lastTotal: string; usage: z.infer<typeof tokenUsage> }
  >();
  private readonly lifecycle = new JobLifecycle();
  get status() {
    return this.lifecycle.status;
  }
  private get closing() {
    return this.lifecycle.closing;
  }
  private readonly pendingTools = Ref.unsafeMake(new Map<string, string | number>());
  private readonly codeInvocations = new Map<
    string,
    {
      threadId: string;
      scope: { subagentId?: string; turnId?: string };
      mcp: Map<string, { server: string; name: string; schema: Record<string, JsonValue> }>;
    }
  >();
  private readonly pendingCode = new Map<string, Deferred.Deferred<JsonValue, Error>>();
  private readonly codeAbort = new AbortController();
  private readonly delegations: Delegations;
  private readonly operations = new Operations();
  private readonly saved = once("codex.checkpoint", async () => {
    if (this.status !== "completed") throw new Error("Only completed turns can be checkpointed");
    await this.stop();
    await writeFile(
      join(this.home, "cf-subagents.json"),
      JSON.stringify({ version: 1, children: Object.fromEntries(this.children) }),
    );
    return capture(this.home, this.threadId);
  });
  private readonly stopped = once("codex.stop", async () => {
    // Children are told first, while their terminal events are still recorded; a
    // root that settles meanwhile reads as cancelled, never completed.
    this.lifecycle.requestCancel();
    await this.delegations.cancelAll();
    this.lifecycle.close();
    this.codeAbort.abort();
    for (const pending of this.pendingCode.values())
      runSync(Deferred.fail(pending, new Error("Execution stopped")));
    this.pendingCode.clear();
    await this.server?.stop();
  });
  readonly home: string;
  constructor(
    readonly execution: Execution,
    private readonly options: CodexOptions,
  ) {
    // Native SQLite stores absolute rollout paths. Keep CODEX_HOME stable across attempts.
    this.home = join(options.directory, "codex");
    this.delegations = new Delegations(execution, {
      endpoint: options.delegateUrl ?? "http://delegate.internal",
      signal: this.codeAbort.signal,
      emit: (event) => this.push(event),
      fail: (error) => {
        this.lifecycle.fail(error);
        void this.stop().catch(options.diagnostics);
      },
      settled: () => this.finishIfReady(),
      diagnostics: options.diagnostics,
      ...(options.delegationTimeouts ? { timeouts: options.delegationTimeouts } : {}),
    });
  }
  start(bundle?: unknown): Promise<void> {
    return runPromise(
      this.lifecycle.transition.withPermits(1)(
        io("codex.start", async () => {
          if (this.closing) throw new Error("Execution has stopped");
          await this.open(bundle);
        }).pipe(
          Effect.onError((cause) =>
            Effect.sync(() => this.failStart(cause)).pipe(
              Effect.zipRight(this.stopped.pipe(Effect.orDie)),
            ),
          ),
        ),
      ),
    );
  }
  private async open(bundle?: unknown): Promise<void> {
    await rm(this.home, { recursive: true, force: true });
    await mkdir(this.home, { recursive: true });
    const previousThread = bundle ? await restore(this.home, bundle) : null;
    if (previousThread) {
      try {
        const saved = z
          .object({ version: z.literal(1), children: z.record(z.string(), childStateSchema) })
          .parse(JSON.parse(await readFile(join(this.home, "cf-subagents.json"), "utf8")));
        for (const [id, child] of Object.entries(saved.children))
          this.children.set(id, { ...child, active: false });
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
    }
    const searchTool = this.execution.agent.tools?.find((tool) => tool.type === "web_search");
    const searchMode = searchTool ? (searchTool.mode ?? "live") : "disabled";
    await writeFile(
      join(this.home, "config.toml"),
      [
        'model_provider = "gateway"',
        `model = ${JSON.stringify(this.execution.model)}`,
        'approval_policy = "never"',
        'sandbox_mode = "danger-full-access"',
        `web_search = ${JSON.stringify(searchMode)}`,
        ...(this.execution.agent.reasoning?.effort
          ? [`model_reasoning_effort = ${JSON.stringify(this.execution.agent.reasoning.effort)}`]
          : []),
        ...(this.execution.agent.reasoning?.summary
          ? [`model_reasoning_summary = ${JSON.stringify(this.execution.agent.reasoning.summary)}`]
          : []),
        ...(this.execution.agent.text?.verbosity
          ? [`model_verbosity = ${JSON.stringify(this.execution.agent.text.verbosity)}`]
          : []),
        "[features]",
        `multi_agent = ${this.execution.agent.multi_agent?.enabled ?? false}`,
        `plugins = ${!!this.execution.capabilityRoots?.length}`,
        `remote_plugin = ${!!this.execution.capabilityRoots?.length}`,
        `executor_capability_discovery = ${!!this.execution.capabilityRoots?.length}`,
        ...(this.execution.agent.tools?.some(
          (tool) => tool.type === "tool_search" || (tool.type === "function" && tool.defer_loading),
        )
          ? ["tool_search = true"]
          : []),
        ...tomlLines(this.options.codexConfig?.features),
        "[agents]",
        `max_concurrent_threads_per_session = ${this.execution.agent.multi_agent?.max_concurrent_subagents ?? 6}`,
        "[model_providers.gateway]",
        'name = "Deployment model gateway"',
        `base_url = ${JSON.stringify(this.options.modelBaseUrl)}`,
        'wire_api = "responses"',
        "requires_openai_auth = false",
        ...tomlLines(this.options.codexConfig?.provider, RESERVED_PROVIDER_KEYS),
      ].join("\n"),
    );
    await writeFile(
      join(this.home, "environments.toml"),
      this.execution.sandbox
        ? `default = "sandbox"\ninclude_local = false\n[[environments]]\nid = "sandbox"\nurl = ${JSON.stringify(this.options.sandboxUrl)}\n`
        : 'default = "none"\ninclude_local = false\n',
    );
    this.server = new AppServer({
      binary: this.options.binary,
      home: this.home,
      directory: this.options.directory,
      onMessage: (message) => this.receive(message),
      onExit: () => {
        if (!this.closing && !["completed", "cancelled", "failed"].includes(this.status)) {
          this.lifecycle.fail("native_harness_exited");
        }
      },
      onDiagnostic: this.options.diagnostics,
    });
    await this.server.request("initialize", {
      clientInfo: { name: "cf-open-agents-api", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    this.server.notify("initialized");
    const mcpServers = Object.fromEntries(
      (this.execution.agent.tools ?? [])
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
    const common = {
      model: this.execution.model,
      modelProvider: "gateway",
      cwd: this.options.directory,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      developerInstructions: this.execution.agent.instructions ?? null,
      serviceTier: this.execution.agent.service_tier ?? null,
      config: {
        mcp_servers: mcpServers,
        web_search: searchMode,
        ...(searchTool
          ? {
              tools: {
                web_search: {
                  context_size: searchTool.context_size ?? "medium",
                  ...(searchTool.allowed_domains == null
                    ? {}
                    : { allowed_domains: searchTool.allowed_domains }),
                  ...(searchTool.location == null ? {} : { location: searchTool.location }),
                },
              },
            }
          : {}),
      },
      selectedCapabilityRoots: (this.execution.capabilityRoots ?? []).map((path, index) => ({
        id: `capability_${index}`,
        location: { type: "environment", environmentId: "sandbox", path },
      })),
    };
    const result = previousThread
      ? await this.server.request("thread/resume", { ...common, threadId: previousThread })
      : await this.server.request("thread/start", {
          ...common,
          dynamicTools: [
            ...(this.execution.agent.tools ?? [])
              .filter((tool) => tool.type === "function")
              .map((tool) => ({
                type: "function",
                name: tool.name,
                description: tool.description,
                inputSchema: tool.parameters,
                deferLoading: tool.defer_loading ?? false,
              })),
            ...(codeEnabled(this.execution)
              ? [{ type: "function", ...programmaticTool, deferLoading: false }]
              : []),
            ...this.delegations.definitions().map((tool) => ({
              type: "function",
              name: tool.name,
              description: tool.description,
              inputSchema: tool.inputSchema,
              deferLoading: false,
            })),
          ],
          environments: this.execution.sandbox
            ? [{ environmentId: "sandbox", cwd: "/workspace" }]
            : [],
        });
    this.threadId = threadResponse.parse(result).thread.id;
    const turn = await this.server.request("turn/start", {
      threadId: this.threadId,
      input: this.input(this.execution.input),
      effort: this.execution.agent.reasoning?.effort ?? null,
      summary: this.execution.agent.reasoning?.summary ?? null,
      outputSchema:
        this.execution.agent.text?.format?.type === "json_schema"
          ? this.execution.agent.text.format.schema
          : null,
      environments: this.execution.sandbox ? [{ environmentId: "sandbox", cwd: "/workspace" }] : [],
    });
    this.nativeTurnId = turnResponse.parse(turn).turn.id;
  }
  private input(messages: Execution["input"]) {
    return messages.flatMap((message) =>
      message.content.map((part) =>
        part.type === "input_text"
          ? { type: "text", text: part.text, text_elements: [] }
          : { type: "image", url: part.image_url },
      ),
    );
  }
  /** Exceeding the retained event budget fails the job; the app-server is then stopped. */
  private push(event: RuntimeEvent): void {
    if (!this.lifecycle.emit(event) && this.status === "failed" && !this.closing)
      void this.stop().catch((error) =>
        this.options.diagnostics(`Failed to stop after output limit: ${String(error)}`),
      );
  }
  private receive(message: RpcMessage): void {
    if (this.closing || !["running", "waiting"].includes(this.status)) return;
    if (message.method === "thread/started") {
      const parsed = z
        .object({
          thread: z.object({
            id: z.string(),
            parentThreadId: z.string().nullable(),
            createdAt: z.number(),
            agentNickname: z.string().nullable().optional(),
          }),
        })
        .safeParse(message.params);
      if (parsed.success && parsed.data.thread.parentThreadId) {
        const thread = parsed.data.thread;
        const parent = thread.parentThreadId;
        if (parent && !this.children.has(thread.id)) {
          const state: ChildState = {
            parent,
            name: thread.agentNickname ?? null,
            instructions: null,
            openedAt: thread.createdAt,
            closed: false,
            active: true,
          };
          this.children.set(thread.id, state);
          this.push({
            type: "subagent",
            id: childId(thread.id),
            parentId: parent === this.threadId ? null : childId(parent),
            name: state.name,
            instructions: null,
            openedAt: state.openedAt,
            status: "active",
          });
        }
      }
      return;
    }
    const context = z
      .object({ threadId: z.string().optional(), turnId: z.string().optional() })
      .safeParse(message.params);
    const nativeThread = context.success ? context.data.threadId : undefined;
    const child = nativeThread ? this.children.get(nativeThread) : undefined;
    const scope =
      child && nativeThread
        ? {
            subagentId: childId(nativeThread),
            turnId: childTurnId(
              context.success && context.data.turnId
                ? context.data.turnId
                : (child.turnId ?? "pending"),
            ),
          }
        : {};
    if (message.method === "turn/started" && nativeThread === this.threadId) {
      const started = turnResponse.safeParse(message.params);
      if (started.success) this.nativeTurnId = started.data.turn.id;
    }
    if (message.method === "thread/tokenUsage/updated") {
      const parsed = z
        .object({
          turnId: z.string(),
          tokenUsage: z.object({ last: tokenUsage, total: tokenUsage }),
        })
        .safeParse(message.params);
      if (!parsed.success || (!child && parsed.data.turnId !== this.nativeTurnId)) return;
      const key = `${nativeThread}:${parsed.data.turnId}`;
      const total = JSON.stringify(parsed.data.tokenUsage.total);
      const previous = this.usageByTurn.get(key);
      if (previous?.lastTotal === total) return;
      const last = parsed.data.tokenUsage.last;
      const usage = {
        inputTokens: (previous?.usage.inputTokens ?? 0) + last.inputTokens,
        cachedInputTokens: (previous?.usage.cachedInputTokens ?? 0) + last.cachedInputTokens,
        outputTokens: (previous?.usage.outputTokens ?? 0) + last.outputTokens,
        reasoningOutputTokens:
          (previous?.usage.reasoningOutputTokens ?? 0) + last.reasoningOutputTokens,
        totalTokens: (previous?.usage.totalTokens ?? 0) + last.totalTokens,
      };
      this.usageByTurn.set(key, { lastTotal: total, usage });
      this.push({
        ...scope,
        type: "usage",
        id: key,
        usage: {
          input_tokens: usage.inputTokens,
          input_tokens_details: { cached_tokens: usage.cachedInputTokens },
          output_tokens: usage.outputTokens,
          output_tokens_details: { reasoning_tokens: usage.reasoningOutputTokens },
          total_tokens: usage.totalTokens,
        },
      });
      return;
    }
    if (
      message.method === "item/reasoning/summaryTextDelta" ||
      message.method === "item/reasoning/summaryPartAdded"
    ) {
      const parsed = z
        .object({
          itemId: z.string(),
          summaryIndex: z.number().int().nonnegative(),
          delta: z.string().optional(),
        })
        .safeParse(message.params);
      if (parsed.success)
        this.push({
          ...scope,
          type:
            message.method === "item/reasoning/summaryTextDelta"
              ? "reasoning_delta"
              : "reasoning_part",
          id: parsed.data.itemId,
          summaryIndex: parsed.data.summaryIndex,
          text: parsed.data.delta ?? "",
        });
      return;
    }
    if (message.method === "item/commandExecution/outputDelta") {
      const parsed = z.object({ itemId: z.string(), delta: z.string() }).safeParse(message.params);
      if (parsed.success)
        this.push({
          ...scope,
          type: "command_delta",
          id: parsed.data.itemId,
          text: parsed.data.delta,
        });
      return;
    }
    if (message.method === "item/started" || message.method === "item/completed") {
      const reasoning = z
        .object({
          item: z.object({
            type: z.literal("reasoning"),
            id: z.string(),
            summary: z.array(z.string()).default([]),
          }),
        })
        .safeParse(message.params);
      if (reasoning.success) {
        this.push({
          ...scope,
          type: "reasoning",
          id: reasoning.data.item.id,
          summary: reasoning.data.item.summary,
          status: message.method === "item/started" ? "in_progress" : "completed",
        });
        return;
      }
      const search = z
        .object({
          item: z.object({
            type: z.literal("webSearch"),
            id: z.string(),
            query: z.string(),
            action: z
              .discriminatedUnion("type", [
                z.object({
                  type: z.literal("search"),
                  query: z.string().nullable().optional(),
                  queries: z.array(z.string()).nullable().optional(),
                }),
                z.object({ type: z.literal("openPage"), url: z.string().nullable().optional() }),
                z.object({
                  type: z.literal("findInPage"),
                  url: z.string().nullable().optional(),
                  pattern: z.string().nullable().optional(),
                }),
                z.object({ type: z.literal("other") }),
              ])
              .nullable()
              .optional(),
          }),
        })
        .safeParse(message.params);
      if (search.success) {
        const action = search.data.item.action;
        this.push({
          ...scope,
          type: "web_search",
          id: search.data.item.id,
          status: message.method === "item/started" ? "in_progress" : "completed",
          action: !action
            ? null
            : action.type === "search"
              ? { type: "search", query: action.query ?? null, queries: action.queries ?? null }
              : action.type === "openPage"
                ? { type: "open_page", url: action.url ?? null }
                : action.type === "findInPage"
                  ? {
                      type: "find_in_page",
                      url: action.url ?? null,
                      pattern: action.pattern ?? null,
                    }
                  : { type: "other" },
        });
        return;
      }
      if (message.method === "item/started") {
        const command = completedItem.safeParse(message.params);
        if (command.success && command.data.item.type === "commandExecution")
          this.push({
            ...scope,
            type: "command_start",
            id: command.data.item.id,
            command: command.data.item.command,
            cwd: command.data.item.cwd ?? null,
          });
      }
    }
    if (message.method === "item/completed") {
      const collab = z
        .object({
          item: z.object({
            type: z.literal("collabAgentToolCall"),
            id: z.string(),
            tool: z.string(),
            status: z.string(),
            senderThreadId: z.string(),
            receiverThreadIds: z.array(z.string()),
            prompt: z.string().nullable(),
            model: z.string().nullable(),
            reasoningEffort: z.string().nullable(),
          }),
        })
        .safeParse(message.params);
      if (collab.success && collab.data.item.status === "completed") {
        const item = collab.data.item;
        for (const id of item.receiverThreadIds) {
          let state = this.children.get(id);
          if (!state && item.tool === "spawnAgent") {
            state = {
              parent: item.senderThreadId,
              name: null,
              instructions: item.prompt,
              openedAt: Math.floor(Date.now() / 1000),
              closed: false,
              active: true,
            };
            this.children.set(id, state);
          }
          if (state) {
            if (item.tool === "spawnAgent") state.instructions = item.prompt;
            if (item.tool === "closeAgent") {
              state.closed = true;
              state.active = false;
            }
            if (
              item.tool === "resumeAgent" ||
              item.tool === "sendInput" ||
              item.tool === "followupTask"
            )
              state.closed = false;
            this.push({
              type: "subagent",
              id: childId(id),
              parentId: state.parent === this.threadId ? null : childId(state.parent),
              name: state.name,
              instructions: state.instructions,
              openedAt: state.openedAt,
              status: state.closed ? "closed" : "active",
            });
          }
        }
      }
      if (collab.success) {
        const item = collab.data.item;
        const operation = z
          .enum([
            "spawnAgent",
            "sendInput",
            "resumeAgent",
            "wait",
            "closeAgent",
            "sendMessage",
            "followupTask",
            "interruptAgent",
          ])
          .safeParse(item.tool);
        if (operation.success)
          this.push({
            ...scope,
            type: "collaboration",
            id: item.id,
            operation: operation.data,
            recipients: item.receiverThreadIds.map(childId),
            prompt: item.prompt,
            model: item.model,
            effort: item.reasoningEffort,
            success: item.status === "completed",
          });
      }
    }
    if (
      child &&
      nativeThread &&
      (message.method === "turn/started" || message.method === "turn/completed")
    ) {
      const result = z
        .object({
          turn: z.object({
            id: z.string(),
            status: z.string(),
            startedAt: z.number().nullable(),
            completedAt: z.number().nullable(),
          }),
        })
        .safeParse(message.params);
      if (!result.success) {
        this.lifecycle.fail("invalid_subagent_turn");
        return;
      }
      const turn = result.data.turn;
      child.turnId = turn.id;
      child.active = message.method === "turn/started";
      this.push({
        type: "subagent_turn",
        id: childTurnId(turn.id),
        subagentId: childId(nativeThread),
        status: child.active
          ? "in_progress"
          : turn.status === "completed"
            ? "completed"
            : turn.status === "interrupted"
              ? "cancelled"
              : "failed",
        startedAt: turn.startedAt ?? child.openedAt,
        completedAt: turn.completedAt,
      });
      if (child.active && this.cancelRequested)
        void this.interrupt(nativeThread, turn.id).catch((error) =>
          this.lifecycle.fail(error instanceof Error ? error.message : "subagent_interrupt_failed"),
        );
      this.finishIfReady();
      return;
    }
    if (message.id !== undefined && message.method) {
      if (message.method === "item/tool/call") {
        const parsed = toolCall.safeParse(message.params);
        if (!parsed.success) {
          this.server?.reject(message.id);
          return;
        }
        if (parsed.data.tool === programmaticTool.name && codeEnabled(this.execution)) {
          const requestId = message.id;
          void this.respondCode(
            requestId,
            parsed.data.arguments,
            nativeThread ?? this.threadId,
            scope,
          ).catch(() => this.lifecycle.fail("programmatic_execution_failed"));
          return;
        }
        if (DELEGATION_TOOLS.has(parsed.data.tool) && this.delegations.enabled) {
          const requestId = message.id;
          void this.delegations
            .call(parsed.data.tool, parsed.data.arguments)
            .then((result) =>
              this.server?.respond(requestId, {
                success: !result.isError,
                contentItems: result.content.map((part) => ({
                  type: "inputText",
                  text: part.text,
                })),
              }),
            )
            .catch(() => this.server?.reject(requestId));
          return;
        }
        runSync(
          Ref.update(this.pendingTools, (pending) =>
            new Map(pending).set(parsed.data.callId, message.id as number | string),
          ),
        );
        this.lifecycle.setStatus("waiting");
        this.push({
          ...scope,
          type: "function_call",
          id: parsed.data.callId,
          callId: parsed.data.callId,
          name: parsed.data.tool,
          arguments: parsed.data.arguments,
        });
      } else if (message.method === "item/tool/requestUserInput") {
        // EXPERIMENTAL Codex tool: no interactive client sits behind this API.
        // Surface the questions as commentary and decline each one so the model
        // continues with its own judgment instead of failing the turn.
        const parsed = userInputRequest.safeParse(message.params);
        if (!parsed.success) {
          this.server?.reject(message.id);
          return;
        }
        const { itemId, questions } = parsed.data;
        this.push({
          ...scope,
          type: "text",
          id: `user_input:${itemId}`,
          phase: "commentary",
          text: [
            "The agent asked for user input; this API cannot collect it interactively, so every question was declined:",
            ...questions.map((question) => {
              const options = question.options?.length
                ? ` Options: ${question.options.map((option) => option.label).join(", ")}.`
                : "";
              return `- ${question.header}: ${question.question}${options}`;
            }),
          ].join("\n"),
        });
        this.server?.respond(message.id, {
          answers: Object.fromEntries(questions.map((question) => [question.id, { answers: [] }])),
        });
      } else {
        this.options.diagnostics(`Rejected unsupported app-server request: ${message.method}`);
        this.server?.reject(message.id);
      }
      return;
    }
    if (message.method === "item/agentMessage/delta") {
      const delta = z.object({ itemId: z.string(), delta: z.string() }).safeParse(message.params);
      if (delta.success)
        this.push({ ...scope, type: "delta", id: delta.data.itemId, text: delta.data.delta });
    } else if (message.method === "item/completed") {
      const result = completedItem.safeParse(message.params);
      if (!result.success) return;
      const item = result.data.item;
      if (item.type === "mcpToolCall") {
        this.push({
          ...scope,
          type: "mcp",
          id: item.id,
          name: item.tool,
          server: item.server,
          arguments: item.arguments,
          output: item.result,
          error: item.error,
          success: item.status === "completed",
        });
        return;
      }
      this.push(
        item.type === "agentMessage"
          ? {
              ...scope,
              type: "text",
              id: item.id,
              text: item.text,
              phase: item.phase ?? "final_answer",
            }
          : {
              ...scope,
              type: "command",
              id: item.id,
              command: item.command,
              output: item.aggregatedOutput ?? "",
              exitCode: item.exitCode ?? null,
              cwd: item.cwd ?? null,
              durationMs: item.durationMs ?? null,
              status:
                item.status === "completed"
                  ? "completed"
                  : item.status === "declined" || item.status === "failed"
                    ? "failed"
                    : item.exitCode === null || item.exitCode === undefined
                      ? "incomplete"
                      : item.exitCode === 0
                        ? "completed"
                        : "failed",
            },
      );
    } else if (message.method === "turn/completed") {
      if (nativeThread && nativeThread !== this.threadId) return;
      const result = z
        .object({
          turn: z.object({
            status: z.string(),
            error: z
              .object({
                message: z.string(),
                codexErrorInfo: z.unknown().optional(),
                additionalDetails: z.string().nullable().optional(),
              })
              .nullable()
              .optional(),
          }),
        })
        .safeParse(message.params);
      if (!result.success) {
        this.lifecycle.fail("invalid_turn_event");
        return;
      }
      if (result.data.turn.status === "completed")
        this.rootOutcome = this.cancelRequested ? "cancelled" : "completed";
      else if (result.data.turn.status === "interrupted") this.rootOutcome = "cancelled";
      else {
        // The public error is a stable Agents API code; the native detail goes to diagnostics.
        const error = result.data.turn.error;
        const code = turnErrorCode(error?.codexErrorInfo, error?.message ?? "");
        this.options.diagnostics(
          `native_turn_failed (${code}): ${error?.message ?? result.data.turn.status}${
            error?.additionalDetails ? ` | ${error.additionalDetails}` : ""
          } codexErrorInfo=${JSON.stringify(error?.codexErrorInfo ?? null)}`,
        );
        this.lifecycle.fail(code);
      }
      this.finishIfReady();
    }
  }
  private finishIfReady(): void {
    if (
      this.rootOutcome &&
      ![...this.children.values()].some((child) => child.active) &&
      !this.delegations.active
    )
      this.lifecycle.setStatus(this.rootOutcome);
  }
  poll(after: number): RuntimeBatch {
    return this.lifecycle.poll(after);
  }
  control(id: string, command: RuntimeCommand): Promise<void> {
    return runPromise(
      this.operations.perform(
        id,
        command,
        this.lifecycle.transition.withPermits(1)(
          io("codex.control", () => this.apply(id, command)),
        ),
      ),
    );
  }
  private async apply(id: string, command: RuntimeCommand): Promise<void> {
    const rejected = (message: string) => new ApiError(409, "command_rejected", message);
    if (command.type === "cancel") {
      // Idempotent: a terminal or unstarted job has nothing left to interrupt.
      if (!this.server || ["completed", "cancelled", "failed"].includes(this.status)) return;
      this.cancelRequested = true;
      // A finished root must read as cancelled before a settling child can seal the outcome.
      this.lifecycle.requestCancel();
      if (this.rootOutcome) this.rootOutcome = "cancelled";
      // Children are told before the shared abort signal closes their route.
      await this.delegations.cancelAll();
      this.codeAbort.abort();
      for (const pending of this.pendingCode.values())
        runSync(Deferred.fail(pending, new Error("Execution cancelled")));
      this.pendingCode.clear();
      if (!this.rootOutcome) await this.interrupt(this.threadId, this.nativeTurnId);
      for (const [threadId, child] of this.children) {
        if (child.active && child.turnId) await this.interrupt(threadId, child.turnId);
      }
      this.finishIfReady();
      return;
    }
    if (!this.server) throw rejected("App-server not started");
    if (this.closing || !["running", "waiting"].includes(this.status))
      throw rejected("Turn is no longer active");
    if (command.type === "steer") {
      try {
        await this.server.request("turn/steer", {
          threadId: this.threadId,
          expectedTurnId: this.nativeTurnId,
          input: this.input(command.input),
        });
      } catch (error) {
        // Codex answered: the steer can never apply to this turn (it ended or
        // moved on). Transport failures stay transient and are retried.
        if (error instanceof RpcError) throw rejected(`Codex rejected the steer: ${error.message}`);
        throw error;
      }
    } else {
      const delegated = this.delegations.owns(command.callId);
      if (delegated) {
        await this.delegations.routeToolResult(delegated, id, command);
        return;
      }
      const codeResult = this.pendingCode.get(command.callId);
      if (codeResult) {
        this.pendingCode.delete(command.callId);
        runSync(
          Deferred.succeed(codeResult, {
            content:
              typeof command.output === "string"
                ? [{ type: "text", text: command.output }]
                : command.output.map((part): JsonValue => {
                    if (part.type === "input_text") return { type: "text", text: part.text };
                    return { type: "image", image_url: part.image_url };
                  }),
            isError: !command.success,
          }),
        );
        this.lifecycle.setStatus(
          this.pendingCode.size || runSync(Ref.get(this.pendingTools)).size ? "waiting" : "running",
        );
        return;
      }
      const requestId = runSync(Ref.get(this.pendingTools)).get(command.callId);
      if (requestId === undefined) throw rejected("Unknown tool call");
      this.server.respond(requestId, {
        success: command.success,
        contentItems:
          typeof command.output === "string"
            ? [{ type: "inputText", text: command.output }]
            : command.output.map((part) =>
                part.type === "input_text"
                  ? { type: "inputText", text: part.text }
                  : { type: "inputImage", imageUrl: part.image_url },
              ),
      });
      const remaining = runSync(
        Ref.updateAndGet(this.pendingTools, (pending) => {
          const next = new Map(pending);
          next.delete(command.callId);
          return next;
        }),
      );
      this.lifecycle.setStatus(remaining.size || this.pendingCode.size ? "waiting" : "running");
    }
  }
  private async respondCode(
    requestId: string | number,
    input: unknown,
    threadId: string,
    scope: { subagentId?: string; turnId?: string },
  ): Promise<void> {
    const invocation = crypto.randomUUID();
    this.codeInvocations.set(invocation, { threadId, scope, mcp: new Map() });
    try {
      const result = await executeCode(
        this.execution,
        input,
        this.codeAbort.signal,
        this.options.programmaticUrl,
        invocation,
      );
      if (result.terminal || (result.isError && this.pendingCode.size))
        throw new Error("Code execution left unfinished tool calls");
      this.server?.respond(requestId, {
        success: !result.isError,
        contentItems: result.content.map((part) => ({ type: "inputText", text: part.text })),
      });
    } catch {
      if (this.cancelRequested || this.closing) return;
      this.lifecycle.fail("programmatic_execution_uncertain");
      await this.stop();
    } finally {
      this.codeInvocations.delete(invocation);
    }
  }
  async codeTools(invocation: string): Promise<string[]> {
    const context = this.codeInvocations.get(invocation);
    if (!context || !this.server) throw new Error("No active code invocation");
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const page = z
        .object({
          data: z.array(
            z.object({
              name: z.string(),
              tools: z.record(
                z.string(),
                z.object({ name: z.string(), inputSchema: z.record(z.string(), z.json()) }),
              ),
            }),
          ),
          nextCursor: z.string().nullish(),
        })
        .parse(
          await this.server.request("mcpServerStatus/list", {
            threadId: context.threadId,
            detail: "toolsAndAuthOnly",
            cursor,
            limit: 100,
          }),
        );
      for (const server of page.data)
        for (const tool of Object.values(server.tools)) {
          const configured = this.execution.agent.tools?.find(
            (tool) => tool.type === "mcp" && tool.server_label === server.name,
          );
          if (
            configured?.type === "mcp" &&
            configured.allowed_tools &&
            !configured.allowed_tools.includes(tool.name)
          )
            continue;
          if (context.mcp.size >= 1000) throw new Error("MCP tool catalog is too large");
          context.mcp.set(`mcp__${server.name}__${tool.name}`, {
            server: server.name,
            name: tool.name,
            schema: tool.inputSchema,
          });
        }
      cursor = page.nextCursor ?? undefined;
      if (cursor && seen.has(cursor)) throw new Error("MCP pagination did not advance");
      if (cursor) seen.add(cursor);
    } while (cursor);
    return [
      ...(this.execution.agent.tools ?? []).flatMap((tool) =>
        tool.type === "function" ? [tool.name] : [],
      ),
      ...(this.execution.sandbox ? Object.keys(workspaceTools) : []),
      ...context.mcp.keys(),
    ];
  }
  async codeTool(name: string, args: unknown, invocation: string): Promise<JsonValue> {
    const context = this.codeInvocations.get(invocation);
    if (!context) throw new Error("No active code invocation");
    if (!codeEnabled(this.execution) || this.closing || this.codeAbort.signal.aborted)
      throw new Error("No active code assignment");
    if (this.execution.sandbox && Object.hasOwn(workspaceTools, name)) {
      const result = await executeWorkspace(
        this.options.sandboxUrl,
        name as keyof typeof workspaceTools,
        args,
        this.codeAbort.signal,
        (event) => this.push({ ...event, ...context.scope }),
      );
      return {
        content: [{ type: "text", text: result.text }],
        isError: result.exitCode !== null && result.exitCode !== 0,
      };
    }
    const mcp = context.mcp.get(name);
    if (mcp) {
      const input = z.json().parse(z.fromJSONSchema(mcp.schema).parse(args));
      const id = `mcp_${crypto.randomUUID().replaceAll("-", "")}`;
      try {
        const output = z.json().parse(
          await this.server?.request("mcpServer/tool/call", {
            threadId: context.threadId,
            server: mcp.server,
            tool: mcp.name,
            arguments: input,
          }),
        );
        this.push({
          ...context.scope,
          type: "mcp",
          id,
          name: mcp.name,
          server: mcp.server,
          arguments: input,
          output,
          error: null,
          success: !(output && typeof output === "object" && "isError" in output && output.isError),
        });
        return output;
      } catch (error) {
        this.push({
          ...context.scope,
          type: "mcp",
          id,
          name: mcp.name,
          server: mcp.server,
          arguments: input,
          output: null,
          error: "MCP request failed",
          success: false,
        });
        throw error;
      }
    }
    const input = functionArguments(this.execution, name, args);
    const id = `call_${crypto.randomUUID().replaceAll("-", "")}`;
    const result = runSync(Deferred.make<JsonValue, Error>());
    this.pendingCode.set(id, result);
    this.push({ ...context.scope, type: "function_call", id, callId: id, name, arguments: input });
    this.lifecycle.setStatus("waiting");
    return runPromise(Deferred.await(result));
  }
  private async interrupt(threadId: string, turnId: string): Promise<void> {
    try {
      await this.server?.request("turn/interrupt", { threadId, turnId });
    } catch (error) {
      // Completion can win the RPC race. Its terminal notification still decides
      // when the job is finished; this acknowledgement alone never does.
      if (!(error instanceof Error && error.message === "no active turn to interrupt")) throw error;
    }
  }
  /** The public error is a stable code; the native reason goes to diagnostics. */
  failStart(error: unknown): void {
    this.options.diagnostics(`native_harness_failed: ${describeFailure(error)}`);
    this.lifecycle.fail("native_harness_failed");
  }
  checkpoint(): Promise<NativeBundle> {
    return runPromise(this.saved);
  }
  stop(): Promise<void> {
    return runPromise(this.lifecycle.transition.withPermits(1)(this.stopped));
  }
}
