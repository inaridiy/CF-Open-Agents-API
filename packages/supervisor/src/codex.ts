import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { Execution, RuntimeCommand } from "cf-open-agents-api";
import { attempt, io, type JsonValue, programmaticTool, workspaceTools } from "cf-open-agents-api";
import { Deferred, Effect, type Scope, Stream } from "effect";
import { z } from "zod";

import { restore } from "./checkpoint.js";
import {
  type CodexConfig,
  configToml,
  environmentsToml,
  mcpServers,
  searchConfig,
} from "./codex-config.js";
import {
  type ChildState,
  childId,
  childStateSchema,
  childTurnId,
  childTurnSchema,
  childTurnStatus,
  type CollabItem,
  collabItem,
  collaborationOperation,
  commandStatus,
  type CompletedItem,
  completedItem,
  contentItems,
  itemDeltaUpdate,
  type Origin,
  originParams,
  reasoningItem,
  reasoningSummaryUpdate,
  rootTurnSchema,
  threadResponse,
  threadStartedNotification,
  type TokenUsage,
  tokenUsageUpdate,
  toolCall,
  turnErrorCode,
  turnResponse,
  userInputRequest,
  webSearchEvent,
  webSearchItem,
} from "./codex-protocol.js";
import { DELEGATION_TOOLS } from "./delegation.js";
import { Job, type JobOptions, ToolUnavailable } from "./job.js";
import { AppServer, type RpcFailure, type RpcMessage } from "./json-rpc.js";
import {
  asFailure,
  CommandRejected,
  describeFailure,
  ExecutionCancelled,
  ExecutionStopped,
  type TaggedFailure,
} from "./lifecycle.js";
import {
  CodeCallsOutstanding,
  codeEnabled,
  codeToolNames,
  executeCode,
  functionArguments,
} from "./programmatic.js";
import { executeWorkspace } from "./workspace.js";

export { messageErrorCode, turnErrorCode } from "./codex-protocol.js";

export interface CodexOptions extends JobOptions {
  binary: string;
  modelBaseUrl: string;
  /** See `CodexConfig`. */
  codexConfig?: CodexConfig;
}

/** One instance per attempt. Workspace I/O goes through the remote environment. */
export class CodexJob extends Job {
  private server?: AppServer;
  private threadId = "";
  private nativeTurnId = "";
  private readonly children = new Map<string, ChildState>();
  private rootOutcome?: "completed" | "cancelled";
  private cancelRequested = false;
  private readonly usageByTurn = new Map<string, { lastTotal: string; usage: TokenUsage }>();
  private readonly pendingTools = new Map<string, string | number>();
  private readonly codeInvocations = new Map<
    string,
    {
      threadId: string;
      scope: { subagentId?: string; turnId?: string };
      mcp: Map<string, { server: string; name: string; schema: Record<string, JsonValue> }>;
    }
  >();
  private readonly pendingCode = new Map<
    string,
    Deferred.Deferred<JsonValue, ExecutionStopped | ExecutionCancelled>
  >();
  readonly home: string;
  constructor(
    execution: Execution,
    protected override readonly options: CodexOptions,
  ) {
    super(execution, options);
    // Native SQLite stores absolute rollout paths. Keep CODEX_HOME stable across attempts.
    this.home = join(options.directory, "codex");
  }
  protected get thread() {
    return this.threadId || undefined;
  }
  protected override settled(): void {
    this.finishIfReady();
  }
  /** Native subagent records ride along with the thread so a resumed turn can attribute them. */
  protected override beforeCapture() {
    return io("codex.subagents", () =>
      writeFile(
        join(this.home, "cf-subagents.json"),
        JSON.stringify({ version: 1, children: Object.fromEntries(this.children) }),
      ),
    );
  }
  private async loadChildren(): Promise<void> {
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
  /** The app-server is acquired into the resource Scope; its release terminates the process. */
  protected acquire(bundle?: unknown): Effect.Effect<void, unknown, Scope.Scope> {
    return Effect.gen(this, function* () {
      yield* io("codex.prepare", async () => {
        await rm(this.home, { recursive: true, force: true });
        await mkdir(this.home, { recursive: true });
      });
      const previousThread = bundle ? yield* restore(this.home, bundle) : null;
      if (previousThread) yield* io("codex.subagents", () => this.loadChildren());
      const searchTool = this.execution.agent.tools?.find((tool) => tool.type === "web_search");
      const searchMode = searchTool ? (searchTool.mode ?? "live") : "disabled";
      yield* io("codex.config", () =>
        writeFile(
          join(this.home, "config.toml"),
          configToml(this.execution, this.options, searchMode),
        ),
      );
      yield* io("codex.environments", () =>
        writeFile(
          join(this.home, "environments.toml"),
          environmentsToml(this.execution, this.options.sandboxUrl),
        ),
      );
      const server = yield* AppServer.acquire({
        binary: this.options.binary,
        home: this.home,
        directory: this.options.directory,
        onDiagnostic: (line) => this.options.diagnostics(line),
      });
      this.server = server;
      // Message translation stays a synchronous switch; one bad message is diagnosed, not fatal.
      yield* Stream.runForEach(server.messages, (message) =>
        Effect.sync(() => this.receive(message)).pipe(
          Effect.catchAllCause((cause) =>
            Effect.sync(() =>
              this.options.diagnostics(`app-server message failed: ${describeFailure(cause)}`),
            ),
          ),
        ),
      ).pipe(Effect.forkScoped);
      yield* server.exited.pipe(
        Effect.andThen(
          Effect.sync(() => {
            if (!this.closing && !["completed", "cancelled", "failed"].includes(this.status))
              this.lifecycle.fail("native_harness_exited");
          }),
        ),
        Effect.forkScoped,
      );
      yield* server.request("initialize", {
        clientInfo: { name: "cf-open-agents-api", version: "0.1.0" },
        capabilities: { experimentalApi: true },
      });
      server.notify("initialized");
      const common = {
        model: this.execution.model,
        modelProvider: "gateway",
        cwd: this.options.directory,
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        developerInstructions: this.execution.agent.instructions ?? null,
        serviceTier: this.execution.agent.service_tier ?? null,
        config: {
          mcp_servers: mcpServers(this.execution),
          web_search: searchMode,
          ...(searchTool ? { tools: { web_search: searchConfig(searchTool) } } : {}),
        },
        selectedCapabilityRoots: (this.execution.capabilityRoots ?? []).map((path, index) => ({
          id: `capability_${index}`,
          location: { type: "environment", environmentId: "sandbox", path },
        })),
      };
      const result = previousThread
        ? yield* server.request("thread/resume", { ...common, threadId: previousThread })
        : yield* server.request("thread/start", {
            ...common,
            dynamicTools: this.dynamicTools(),
            environments: this.environments,
          });
      this.threadId = yield* attempt("codex.thread", () => threadResponse.parse(result).thread.id);
      const turn = yield* server.request("turn/start", {
        threadId: this.threadId,
        input: this.input(this.execution.input),
        effort: this.execution.agent.reasoning?.effort ?? null,
        summary: this.execution.agent.reasoning?.summary ?? null,
        outputSchema: this.outputSchema,
        environments: this.environments,
      });
      this.nativeTurnId = yield* attempt("codex.turn", () => turnResponse.parse(turn).turn.id);
    });
  }
  /** The remote environment every thread and turn of this job runs in, when the execution has one. */
  private get environments() {
    return this.execution.sandbox ? [{ environmentId: "sandbox", cwd: "/workspace" }] : [];
  }
  private get outputSchema() {
    const format = this.execution.agent.text?.format;
    return format?.type === "json_schema" ? format.schema : null;
  }
  /** Client function tools, the programmatic tool and delegation tools, as Codex dynamic tools. */
  private dynamicTools() {
    const dynamic = (tool: {
      name: string;
      description: string | undefined;
      inputSchema: unknown;
      deferLoading?: boolean;
    }) => ({ type: "function", deferLoading: false, ...tool });
    return [
      ...(this.execution.agent.tools ?? [])
        .filter((tool) => tool.type === "function")
        .map((tool) =>
          dynamic({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.parameters,
            deferLoading: tool.defer_loading ?? false,
          }),
        ),
      ...(codeEnabled(this.execution) ? [dynamic(programmaticTool)] : []),
      ...this.delegations.definitions().map((tool) =>
        dynamic({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        }),
      ),
    ];
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
  /**
   * One app-server message. Server requests (they carry an `id`) are answered;
   * notifications are dispatched by method. Both attribute their events to the
   * native thread named in `params`, which is the root or a known child.
   */
  private receive(message: RpcMessage): void {
    if (this.closing || !["running", "waiting"].includes(this.status)) return;
    const { method, params } = message;
    if (method === undefined) return;
    const origin = this.origin(params);
    if (message.id !== undefined) this.serverRequest(message.id, method, params, origin);
    else this.notifications.get(method)?.(params, origin);
  }
  private origin(params: unknown): Origin {
    const context = originParams.safeParse(params);
    const nativeThread = context.success ? context.data.threadId : undefined;
    const child = nativeThread ? this.children.get(nativeThread) : undefined;
    if (!child || !nativeThread) return { nativeThread, scope: {} };
    const turnId =
      context.success && context.data.turnId ? context.data.turnId : (child.turnId ?? "pending");
    return {
      nativeThread,
      child,
      scope: { subagentId: childId(nativeThread), turnId: childTurnId(turnId) },
    };
  }
  private readonly notifications = new Map<string, (params: unknown, origin: Origin) => void>([
    ["thread/started", (params) => this.threadStarted(params)],
    ["turn/started", (params, origin) => this.turnStarted(params, origin)],
    ["turn/completed", (params, origin) => this.turnCompleted(params, origin)],
    ["thread/tokenUsage/updated", (params, origin) => this.tokenUsage(params, origin)],
    [
      "item/reasoning/summaryTextDelta",
      (params, origin) => this.reasoningSummary("reasoning_delta", params, origin),
    ],
    [
      "item/reasoning/summaryPartAdded",
      (params, origin) => this.reasoningSummary("reasoning_part", params, origin),
    ],
    [
      "item/commandExecution/outputDelta",
      (params, origin) => this.itemDelta("command_delta", params, origin),
    ],
    ["item/agentMessage/delta", (params, origin) => this.itemDelta("delta", params, origin)],
    ["item/started", (params, origin) => this.itemStarted(params, origin)],
    ["item/completed", (params, origin) => this.itemCompleted(params, origin)],
  ]);
  private itemDelta(type: "command_delta" | "delta", params: unknown, origin: Origin): void {
    const parsed = itemDeltaUpdate.safeParse(params);
    if (parsed.success)
      this.emit({ ...origin.scope, type, id: parsed.data.itemId, text: parsed.data.delta });
  }
  private serverRequest(id: string | number, method: string, params: unknown, origin: Origin) {
    if (method === "item/tool/call") {
      this.toolCall(id, params, origin);
      return;
    }
    if (method === "item/tool/requestUserInput") {
      this.userInputRequest(id, params, origin);
      return;
    }
    this.options.diagnostics(`Rejected unsupported app-server request: ${method}`);
    this.server?.reject(id);
  }
  /** A native subagent thread opened; it is tracked from its first notification. */
  private threadStarted(params: unknown): void {
    const parsed = threadStartedNotification.safeParse(params);
    if (!parsed.success) return;
    const thread = parsed.data.thread;
    const parent = thread.parentThreadId;
    if (!parent || this.children.has(thread.id)) return;
    const state: ChildState = {
      parent,
      name: thread.agentNickname ?? null,
      instructions: null,
      openedAt: thread.createdAt,
      closed: false,
      active: true,
    };
    this.children.set(thread.id, state);
    this.emit({
      type: "subagent",
      id: childId(thread.id),
      parentId: parent === this.threadId ? null : childId(parent),
      name: state.name,
      instructions: null,
      openedAt: state.openedAt,
      status: "active",
    });
  }
  private turnStarted(params: unknown, origin: Origin): void {
    if (origin.child && origin.nativeThread) {
      this.childTurn(params, origin.nativeThread, origin.child, true);
      return;
    }
    if (origin.nativeThread !== this.threadId) return;
    const started = turnResponse.safeParse(params);
    if (started.success) this.nativeTurnId = started.data.turn.id;
  }
  private turnCompleted(params: unknown, origin: Origin): void {
    if (origin.child && origin.nativeThread) {
      this.childTurn(params, origin.nativeThread, origin.child, false);
      return;
    }
    if (origin.nativeThread && origin.nativeThread !== this.threadId) return;
    this.rootTurnCompleted(params);
  }
  /** A child's turn started or ended; a cancel in flight interrupts a child that starts late. */
  private childTurn(params: unknown, nativeThread: string, child: ChildState, started: boolean) {
    const result = childTurnSchema.safeParse(params);
    if (!result.success) {
      this.lifecycle.fail("invalid_subagent_turn");
      return;
    }
    const turn = result.data.turn;
    child.turnId = turn.id;
    child.active = started;
    this.emit({
      type: "subagent_turn",
      id: childTurnId(turn.id),
      subagentId: childId(nativeThread),
      status: childTurnStatus(child.active, turn.status),
      startedAt: turn.startedAt ?? child.openedAt,
      completedAt: turn.completedAt,
    });
    if (child.active && this.cancelRequested)
      void this.perform(this.interruptNative(nativeThread, turn.id)).catch((error) =>
        this.lifecycle.fail(error instanceof Error ? error.message : "subagent_interrupt_failed"),
      );
    this.finishIfReady();
  }
  /** The root turn ended: the public outcome is decided, the native detail goes to diagnostics. */
  private rootTurnCompleted(params: unknown): void {
    const result = rootTurnSchema.safeParse(params);
    if (!result.success) {
      this.lifecycle.fail("invalid_turn_event");
      return;
    }
    const turn = result.data.turn;
    if (turn.status === "completed")
      this.rootOutcome = this.cancelRequested ? "cancelled" : "completed";
    else if (turn.status === "interrupted") this.rootOutcome = "cancelled";
    else {
      // The public error is a stable Agents API code; the native detail goes to diagnostics.
      const error = turn.error;
      const code = turnErrorCode(error?.codexErrorInfo, error?.message ?? "");
      const details = error?.additionalDetails ? ` | ${error.additionalDetails}` : "";
      this.options.diagnostics(
        `native_turn_failed (${code}): ${error?.message ?? turn.status}${details} codexErrorInfo=${JSON.stringify(error?.codexErrorInfo ?? null)}`,
      );
      this.lifecycle.fail(code);
    }
    this.finishIfReady();
  }
  /** Codex reports cumulative totals per turn; the public usage is accumulated per thread turn. */
  private tokenUsage(params: unknown, origin: Origin): void {
    const parsed = tokenUsageUpdate.safeParse(params);
    if (!parsed.success || (!origin.child && parsed.data.turnId !== this.nativeTurnId)) return;
    const key = `${origin.nativeThread}:${parsed.data.turnId}`;
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
    this.emit({
      ...origin.scope,
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
  }
  private reasoningSummary(
    type: "reasoning_delta" | "reasoning_part",
    params: unknown,
    origin: Origin,
  ): void {
    const parsed = reasoningSummaryUpdate.safeParse(params);
    if (parsed.success)
      this.emit({
        ...origin.scope,
        type,
        id: parsed.data.itemId,
        summaryIndex: parsed.data.summaryIndex,
        text: parsed.data.delta ?? "",
      });
  }
  /** Items of the kinds the API streams while they run; other kinds are reported once completed. */
  private itemStarted(params: unknown, origin: Origin): void {
    const reasoning = reasoningItem.safeParse(params);
    if (reasoning.success) {
      this.emit({
        ...origin.scope,
        type: "reasoning",
        id: reasoning.data.item.id,
        summary: reasoning.data.item.summary,
        status: "in_progress",
      });
      return;
    }
    const search = webSearchItem.safeParse(params);
    if (search.success) {
      this.emit(webSearchEvent(search.data.item, "in_progress", origin.scope));
      return;
    }
    const command = completedItem.safeParse(params);
    if (command.success && command.data.item.type === "commandExecution")
      this.emit({
        ...origin.scope,
        type: "command_start",
        id: command.data.item.id,
        command: command.data.item.command,
        cwd: command.data.item.cwd ?? null,
      });
  }
  private itemCompleted(params: unknown, origin: Origin): void {
    const reasoning = reasoningItem.safeParse(params);
    if (reasoning.success) {
      this.emit({
        ...origin.scope,
        type: "reasoning",
        id: reasoning.data.item.id,
        summary: reasoning.data.item.summary,
        status: "completed",
      });
      return;
    }
    const search = webSearchItem.safeParse(params);
    if (search.success) {
      this.emit(webSearchEvent(search.data.item, "completed", origin.scope));
      return;
    }
    const collab = collabItem.safeParse(params);
    if (collab.success) {
      this.collaboration(collab.data.item, origin);
      return;
    }
    const result = completedItem.safeParse(params);
    if (result.success) this.completedItem(result.data.item, origin);
  }
  /** A multi-agent tool call: it opens, closes or resumes child records, then reads as a collaboration item. */
  private collaboration(item: CollabItem, origin: Origin): void {
    if (item.status === "completed")
      for (const id of item.receiverThreadIds) this.trackChild(id, item);
    const operation = collaborationOperation.safeParse(item.tool);
    if (operation.success)
      this.emit({
        ...origin.scope,
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
  private trackChild(id: string, item: CollabItem): void {
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
    if (!state) return;
    if (item.tool === "spawnAgent") state.instructions = item.prompt;
    if (item.tool === "closeAgent") {
      state.closed = true;
      state.active = false;
    }
    if (item.tool === "resumeAgent" || item.tool === "sendInput" || item.tool === "followupTask")
      state.closed = false;
    this.emit({
      type: "subagent",
      id: childId(id),
      parentId: state.parent === this.threadId ? null : childId(state.parent),
      name: state.name,
      instructions: state.instructions,
      openedAt: state.openedAt,
      status: state.closed ? "closed" : "active",
    });
  }
  private completedItem(item: CompletedItem, origin: Origin): void {
    switch (item.type) {
      case "mcpToolCall":
        this.emit({
          ...origin.scope,
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
      case "agentMessage":
        this.emit({
          ...origin.scope,
          type: "text",
          id: item.id,
          text: item.text,
          phase: item.phase ?? "final_answer",
        });
        return;
      case "commandExecution":
        this.emit({
          ...origin.scope,
          type: "command",
          id: item.id,
          command: item.command,
          output: item.aggregatedOutput ?? "",
          exitCode: item.exitCode ?? null,
          cwd: item.cwd ?? null,
          durationMs: item.durationMs ?? null,
          status: commandStatus(item),
        });
    }
  }
  /** A dynamic tool call: code and delegation are answered here; client functions wait for the Worker. */
  private toolCall(requestId: string | number, params: unknown, origin: Origin): void {
    const parsed = toolCall.safeParse(params);
    if (!parsed.success) {
      this.server?.reject(requestId);
      return;
    }
    if (parsed.data.tool === programmaticTool.name && codeEnabled(this.execution)) {
      void this.respondCode(
        requestId,
        parsed.data.arguments,
        origin.nativeThread ?? this.threadId,
        origin.scope,
      ).catch(() => this.lifecycle.fail("programmatic_execution_failed"));
      return;
    }
    if (DELEGATION_TOOLS.has(parsed.data.tool) && this.delegations.enabled) {
      void this.perform(this.delegations.call(parsed.data.tool, parsed.data.arguments))
        .then((result) =>
          this.server?.respond(requestId, {
            success: !result.isError,
            contentItems: result.content.map((part) => ({ type: "inputText", text: part.text })),
          }),
        )
        .catch(() => this.server?.reject(requestId));
      return;
    }
    this.pendingTools.set(parsed.data.callId, requestId);
    this.lifecycle.setStatus("waiting");
    this.emit({
      ...origin.scope,
      type: "function_call",
      id: parsed.data.callId,
      callId: parsed.data.callId,
      name: parsed.data.tool,
      arguments: parsed.data.arguments,
    });
  }
  /**
   * EXPERIMENTAL Codex tool: no interactive client sits behind this API. Surface the
   * questions as commentary and decline each one so the model continues with its
   * own judgment instead of failing the turn.
   */
  private userInputRequest(requestId: string | number, params: unknown, origin: Origin): void {
    const parsed = userInputRequest.safeParse(params);
    if (!parsed.success) {
      this.server?.reject(requestId);
      return;
    }
    const { itemId, questions } = parsed.data;
    this.emit({
      ...origin.scope,
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
    this.server?.respond(requestId, {
      answers: Object.fromEntries(questions.map((question) => [question.id, { answers: [] }])),
    });
  }
  private finishIfReady(): void {
    if (
      this.rootOutcome &&
      ![...this.children.values()].some((child) => child.active) &&
      !this.delegations.active
    )
      this.lifecycle.setStatus(this.rootOutcome);
  }
  protected override abandon(): void {
    const failure = Effect.fail(new ExecutionStopped());
    for (const pending of this.pendingCode.values()) Deferred.unsafeDone(pending, failure);
    this.pendingCode.clear();
  }
  protected prepareCommand() {
    return Effect.void;
  }
  protected apply(id: string, command: RuntimeCommand) {
    return Effect.gen(this, function* () {
      if (command.type === "cancel") return yield* this.cancelTurn();
      const server = this.server;
      if (!server) return yield* new CommandRejected({ reason: "App-server not started" });
      if (this.closing || !["running", "waiting"].includes(this.status))
        return yield* new CommandRejected({ reason: "Turn is no longer active" });
      if (command.type === "steer") return yield* this.steerTurn(server, command.input);
      const delegated = this.delegations.owns(command.callId);
      if (delegated) return yield* this.delegations.routeToolResult(delegated, id, command);
      const codeResult = this.pendingCode.get(command.callId);
      if (codeResult) return yield* this.answerCode(command, codeResult);
      const requestId = this.pendingTools.get(command.callId);
      if (requestId === undefined)
        return yield* new CommandRejected({ reason: "Unknown tool call" });
      server.respond(requestId, { success: command.success, contentItems: contentItems(command) });
      this.pendingTools.delete(command.callId);
      this.settleWaiting();
    });
  }
  /** Idempotent: a terminal or unstarted job has nothing left to interrupt. */
  private cancelTurn(): Effect.Effect<void, RpcFailure> {
    return Effect.gen(this, function* () {
      if (!this.server || ["completed", "cancelled", "failed"].includes(this.status)) return;
      this.cancelRequested = true;
      // A finished root must read as cancelled before a settling child can seal the outcome.
      this.lifecycle.requestCancel();
      if (this.rootOutcome) this.rootOutcome = "cancelled";
      // Children are told before the shared abort signal closes their route.
      yield* this.delegations.cancelAll();
      this.abort.abort();
      for (const pending of this.pendingCode.values())
        yield* Deferred.fail(pending, new ExecutionCancelled());
      this.pendingCode.clear();
      if (!this.rootOutcome) yield* this.interruptNative(this.threadId, this.nativeTurnId);
      for (const [threadId, child] of this.children) {
        if (child.active && child.turnId) yield* this.interruptNative(threadId, child.turnId);
      }
      this.finishIfReady();
    });
  }
  /**
   * Codex answered: the steer can never apply to this turn (it ended or moved on).
   * Transport failures stay transient and are retried.
   */
  private steerTurn(
    server: AppServer,
    input: Execution["input"],
  ): Effect.Effect<void, CommandRejected | RpcFailure> {
    return server
      .request("turn/steer", {
        threadId: this.threadId,
        expectedTurnId: this.nativeTurnId,
        input: this.input(input),
      })
      .pipe(
        Effect.asVoid,
        Effect.catchTag(
          "RpcError",
          (error) => new CommandRejected({ reason: `Codex rejected the steer: ${error.message}` }),
        ),
      );
  }
  /** A client function result for a call that running code raised. */
  private answerCode(
    command: Extract<RuntimeCommand, { type: "tool_result" }>,
    result: Deferred.Deferred<JsonValue, ExecutionStopped | ExecutionCancelled>,
  ): Effect.Effect<void> {
    return Effect.gen(this, function* () {
      this.pendingCode.delete(command.callId);
      const content: JsonValue =
        typeof command.output === "string"
          ? [{ type: "text", text: command.output }]
          : command.output.map((part): JsonValue =>
              part.type === "input_text"
                ? { type: "text", text: part.text }
                : { type: "image", image_url: part.image_url },
            );
      yield* Deferred.succeed(result, { content, isError: !command.success });
      this.settleWaiting();
    });
  }
  /** Waiting while any client call is open; running once the last one is answered. */
  private settleWaiting(): void {
    this.lifecycle.setStatus(
      this.pendingCode.size || this.pendingTools.size ? "waiting" : "running",
    );
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
        this.abort.signal,
        this.options.programmaticUrl,
        invocation,
      );
      if (result.terminal || (result.isError && this.pendingCode.size))
        throw new CodeCallsOutstanding();
      this.server?.respond(requestId, {
        success: !result.isError,
        contentItems: result.content.map((part) => ({ type: "inputText", text: part.text })),
      });
    } catch {
      if (this.cancelRequested || this.closing) return;
      this.lifecycle.fail("programmatic_execution_uncertain");
      this.requestStop();
    } finally {
      this.codeInvocations.delete(invocation);
    }
  }
  private readonly mcpStatusPage = z.object({
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
  });
  codeTools(invocation: string): Effect.Effect<string[], TaggedFailure> {
    return Effect.gen(this, function* () {
      const context = this.codeInvocations.get(invocation);
      const server = this.server;
      if (!context || !server)
        return yield* new ToolUnavailable({ message: "No active code invocation" });
      let cursor: string | undefined;
      const seen = new Set<string>();
      do {
        const listed = yield* server.request("mcpServerStatus/list", {
          threadId: context.threadId,
          detail: "toolsAndAuthOnly",
          cursor,
          limit: 100,
        });
        const page = yield* attempt("codex.mcpServers", () => this.mcpStatusPage.parse(listed));
        for (const listing of page.data)
          for (const tool of Object.values(listing.tools)) {
            const configured = this.execution.agent.tools?.find(
              (candidate) => candidate.type === "mcp" && candidate.server_label === listing.name,
            );
            if (
              configured?.type === "mcp" &&
              configured.allowed_tools &&
              !configured.allowed_tools.includes(tool.name)
            )
              continue;
            if (context.mcp.size >= 1000)
              return yield* new ToolUnavailable({ message: "MCP tool catalog is too large" });
            context.mcp.set(`mcp__${listing.name}__${tool.name}`, {
              server: listing.name,
              name: tool.name,
              schema: tool.inputSchema,
            });
          }
        cursor = page.nextCursor ?? undefined;
        if (cursor && seen.has(cursor))
          return yield* new ToolUnavailable({ message: "MCP pagination did not advance" });
        if (cursor) seen.add(cursor);
      } while (cursor);
      return [...codeToolNames(this.execution), ...context.mcp.keys()];
    }).pipe(Effect.mapError(asFailure("codex.codeTools")));
  }
  codeTool(
    name: string,
    args: unknown,
    invocation: string,
  ): Effect.Effect<JsonValue, TaggedFailure> {
    return Effect.gen(this, function* () {
      const context = this.codeInvocations.get(invocation);
      if (!context) return yield* new ToolUnavailable({ message: "No active code invocation" });
      if (!codeEnabled(this.execution) || this.closing || this.abort.signal.aborted)
        return yield* new ToolUnavailable({ message: "No active code assignment" });
      if (this.execution.sandbox && Object.hasOwn(workspaceTools, name)) {
        const result = yield* io("codex.workspace", () =>
          executeWorkspace(
            this.options.sandboxUrl,
            name as keyof typeof workspaceTools,
            args,
            this.abort.signal,
            (event) => this.emit({ ...event, ...context.scope }),
          ),
        );
        return {
          content: [{ type: "text", text: result.text }],
          isError: result.exitCode !== null && result.exitCode !== 0,
        };
      }
      const mcp = context.mcp.get(name);
      if (mcp) {
        const input = yield* attempt("codex.mcpInput", () =>
          z.json().parse(z.fromJSONSchema(mcp.schema).parse(args)),
        );
        const id = `mcp_${crypto.randomUUID().replaceAll("-", "")}`;
        const record = (output: JsonValue | null, error: string | null, success: boolean) =>
          this.emit({
            ...context.scope,
            type: "mcp",
            id,
            name: mcp.name,
            server: mcp.server,
            arguments: input,
            output,
            error,
            success,
          });
        const server = this.server;
        if (!server) return yield* new ToolUnavailable({ message: "No active code invocation" });
        return yield* server
          .request("mcpServer/tool/call", {
            threadId: context.threadId,
            server: mcp.server,
            tool: mcp.name,
            arguments: input,
          })
          .pipe(
            Effect.flatMap((raw) => attempt("codex.mcpOutput", () => z.json().parse(raw))),
            Effect.tap((output) =>
              Effect.sync(() =>
                record(
                  output,
                  null,
                  !(output && typeof output === "object" && "isError" in output && output.isError),
                ),
              ),
            ),
            Effect.tapError(() => Effect.sync(() => record(null, "MCP request failed", false))),
          );
      }
      const input = yield* attempt("codex.functionArguments", () =>
        functionArguments(this.execution, name, args),
      );
      const id = `call_${crypto.randomUUID().replaceAll("-", "")}`;
      const result = yield* Deferred.make<JsonValue, ExecutionStopped | ExecutionCancelled>();
      this.pendingCode.set(id, result);
      this.emit({
        ...context.scope,
        type: "function_call",
        id,
        callId: id,
        name,
        arguments: input,
      });
      this.lifecycle.setStatus("waiting");
      return yield* Deferred.await(result);
    }).pipe(Effect.mapError(asFailure("codex.codeTool")));
  }
  private interruptNative(threadId: string, turnId: string): Effect.Effect<void, RpcFailure> {
    return this.server
      ? this.server.request("turn/interrupt", { threadId, turnId }).pipe(
          Effect.asVoid,
          // Completion can win the RPC race. Its terminal notification still decides
          // when the job is finished; this acknowledgement alone never does.
          Effect.catchTag("RpcError", (error) =>
            error.message === "no active turn to interrupt" ? Effect.void : Effect.fail(error),
          ),
        )
      : Effect.void;
  }
}
