import { mkdir, rm } from "node:fs/promises";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  CallToolResultSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import {
  ApiError,
  type Execution,
  type InputMessage,
  io,
  type JsonValue,
  OperationError,
  programmaticTool,
  type RuntimeBatch,
  type RuntimeCommand,
  type RuntimeEvent,
  runPromise,
  runSync,
  type ServiceError,
  type WorkspaceToolName,
  workspaceTools,
} from "cf-open-agents-api";
import { Deferred, Effect, Exit, Fiber, Ref, Scope } from "effect";
import { z } from "zod";

import { capture, type NativeBundle, restore } from "./checkpoint.js";
import { DELEGATION_TOOLS, type DelegationOptions, Delegations } from "./delegation.js";
import { describeFailure, JobLifecycle, Operations, once } from "./lifecycle.js";
import { imageContent } from "./media.js";
import { codeEnabled, executeCode, functionArguments } from "./programmatic.js";
import { RemoteTools } from "./remote-tools.js";
import { executeWorkspace } from "./workspace.js";

type ToolResult = {
  content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[];
  isError: boolean;
};

/** Attribution of events raised on behalf of a native subagent. */
export interface ToolScope {
  subagentId: string;
  turnId: string;
}

export interface NativeJob {
  readonly execution: Execution;
  readonly status: RuntimeBatch["status"];
  start(bundle?: unknown): Promise<void>;
  poll(after: number): RuntimeBatch;
  control(operationId: string, command: RuntimeCommand): Promise<void>;
  checkpoint(): Promise<NativeBundle>;
  stop(): Promise<void>;
  failStart(error: unknown): void;
  mcp?(request: Request): Promise<Response>;
  codeTool?(name: string, args: unknown, invocation: string): Promise<JsonValue>;
  codeTools?(invocation: string): Promise<string[]>;
  workspace?(
    name: WorkspaceToolName,
    args: unknown,
  ): Promise<{ text: string; exitCode: number | null }>;
}

export interface NativeOptions {
  directory: string;
  modelBaseUrl: string;
  sandboxUrl: string;
  supervisorUrl: string;
  opencodeBinary: string;
  diagnostics(line: string): void;
  programmaticUrl?: string;
  mediaUrl?: string;
  delegateUrl?: string;
  /** Bounds for delegate round trips; tests shorten them. */
  delegationTimeouts?: DelegationOptions["timeouts"];
}

/** Shared transport/lifecycle bookkeeping; inference remains in the native harness. */
export abstract class ToolJob implements NativeJob {
  protected readonly lifecycle = new JobLifecycle();
  get status() {
    return this.lifecycle.status;
  }
  protected get closing() {
    return this.lifecycle.closing;
  }
  protected get cancelling() {
    return this.lifecycle.cancelling;
  }
  protected sessionId = "";
  protected readonly abort = new AbortController();
  private readonly scope = runSync(Scope.make());
  private task?: Fiber.RuntimeFiber<void, never>;
  private readonly pending = Ref.unsafeMake(
    new Map<string, Deferred.Deferred<ToolResult, Error>>(),
  );
  private readonly operations = new Operations();
  protected readonly remoteTools = new RemoteTools(this.abort.signal, (event) => this.emit(event));
  protected readonly delegations: Delegations;
  private readonly discovered = new Set<string>();
  /** Client function calls raised by each live code invocation; settled calls leave the set. */
  private readonly codeCalls = new Map<string, Set<string>>();
  private readonly saved = once("native.checkpoint", async () => {
    if (this.status !== "completed" || !this.sessionId)
      throw new Error("Native turn must complete before checkpointing");
    await this.stop();
    return capture(this.home, this.sessionId);
  });
  private readonly stopped = once("native.stop", async () => {
    // Children are told first, while their terminal events are still recorded and
    // this job can still reach its HarnessDO route; closing then seals the log.
    // A task that finishes meanwhile reads as cancelled, never completed.
    this.lifecycle.requestCancel();
    await this.delegations.cancelAll();
    // A runtime that can stop gracefully reports its final usage before the log seals.
    await this.interruptRuntime().catch((error) =>
      this.options.diagnostics(`interrupt failed: ${describeFailure(error)}`),
    );
    this.lifecycle.close();
    this.abort.abort();
    const pending = runSync(Ref.getAndSet(this.pending, new Map()));
    for (const result of pending.values())
      runSync(Deferred.fail(result, new Error("Execution stopped")));
    await this.remoteTools.close();
    await this.closeRuntime();
    await runPromise(Scope.close(this.scope, Exit.void));
    if (this.task) await runPromise(Fiber.await(this.task));
  });
  abstract readonly home: string;
  constructor(
    readonly execution: Execution,
    protected readonly options: NativeOptions,
  ) {
    this.delegations = new Delegations(execution, {
      endpoint: options.delegateUrl ?? "http://delegate.internal",
      signal: this.abort.signal,
      emit: (event) => this.emit(event),
      fail: (error) => {
        this.lifecycle.fail(error);
        void this.stop().catch(() => options.diagnostics("Failed to stop after child failure"));
      },
      diagnostics: (line) => options.diagnostics(line),
      ...(options.delegationTimeouts ? { timeouts: options.delegationTimeouts } : {}),
    });
  }
  start(bundle?: unknown): Promise<void> {
    return runPromise(
      this.lifecycle.transition.withPermits(1)(
        io("native.start", async () => {
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
  protected abstract open(bundle?: unknown): Promise<void>;
  protected abstract closeRuntime(): Promise<void>;
  /**
   * Ask the native runtime to end the current turn gracefully before the job is
   * closed; runtimes that can report usage for an interrupted turn override this.
   * Bounded by the implementation; the default returns immediately.
   */
  protected interruptRuntime(): Promise<void> {
    return Promise.resolve();
  }
  /**
   * Deliver input to the running native turn. Runtimes that can queue or inject
   * messages override this; the default rejects, which the HarnessDO reports as
   * `command_rejected` so the Worker re-queues the message as the next turn.
   */
  protected steer(_input: InputMessage[]): Promise<void> {
    return Promise.reject(
      new ApiError(409, "command_rejected", "This harness cannot steer an active turn"),
    );
  }
  protected async prepare(bundle?: unknown): Promise<string | undefined> {
    await rm(this.home, { recursive: true, force: true });
    await mkdir(this.home, { recursive: true });
    const previous = bundle ? await restore(this.home, bundle) : undefined;
    await this.remoteTools.open(this.execution);
    return previous;
  }
  /** Exceeding the retained event budget fails the job; the runtime is then stopped. */
  protected emit(event: RuntimeEvent): void {
    if (!this.lifecycle.emit(event) && this.status === "failed" && !this.closing)
      void this.stop().catch(() => this.options.diagnostics("Failed to stop after output limit"));
  }
  protected run(task: () => Promise<void>): void {
    this.task = runSync(
      io("native.run", async () => {
        await task();
        // Like native Codex children, delegated children finish before the parent completes.
        await this.delegations.settle();
      }).pipe(
        Effect.tap(() => Effect.sync(() => this.lifecycle.setStatus("completed"))),
        Effect.catchAllCause((cause) =>
          Effect.sync(() => {
            // A stop interrupts the task deliberately; that is not a harness failure.
            if (!this.closing) this.failStart(cause);
          }),
        ),
        Effect.forkIn(this.scope),
      ),
    );
  }
  /** The public error is a stable code; the native reason goes to diagnostics. */
  failStart(error: unknown): void {
    this.options.diagnostics(`native_harness_failed: ${describeFailure(error)}`);
    this.lifecycle.fail("native_harness_failed");
  }
  poll(after: number): RuntimeBatch {
    return this.lifecycle.poll(after);
  }
  async workspace(
    name: WorkspaceToolName,
    args: unknown,
    scope?: ToolScope,
  ): Promise<{ text: string; exitCode: number | null }> {
    if (!this.execution.sandbox || this.closing || this.abort.signal.aborted)
      throw new Error("No active sandbox assignment");
    return executeWorkspace(this.options.sandboxUrl, name, args, this.abort.signal, (event) =>
      this.emit(scope ? { ...event, ...scope } : event),
    );
  }

  protected externalTool(
    name: string,
    args: unknown,
    invocation?: string,
    scope?: ToolScope,
  ): Promise<ToolResult> {
    return runPromise(
      Effect.gen(this, function* () {
        if (this.closing || this.abort.signal.aborted)
          return yield* Effect.fail(new Error("Execution has stopped"));
        const callId = `call_${crypto.randomUUID().replaceAll("-", "")}`;
        const result = yield* Deferred.make<ToolResult, Error>();
        yield* Ref.update(this.pending, (pending) => new Map(pending).set(callId, result));
        if (invocation) this.codeCalls.get(invocation)?.add(callId);
        this.emit({
          type: "function_call",
          id: callId,
          callId,
          name,
          arguments: z.json().parse(args),
          ...scope,
        });
        this.lifecycle.setStatus("waiting");
        return yield* Deferred.await(result);
      }),
    );
  }
  protected async executeCode(input: unknown) {
    const invocation = crypto.randomUUID();
    // Only calls this invocation raised count as unfinished; a native call the
    // runtime issued in parallel belongs to the runtime, not to the code.
    const raised = new Set<string>();
    this.codeCalls.set(invocation, raised);
    try {
      const result = await executeCode(
        this.execution,
        input,
        this.abort.signal,
        this.options.programmaticUrl,
        invocation,
      );
      if (result.terminal || (result.isError && raised.size))
        throw new Error("Code execution left unfinished tool calls");
      return result;
    } catch (error) {
      this.lifecycle.fail("programmatic_execution_uncertain");
      this.abort.abort();
      void this.stop().catch(() => this.options.diagnostics("Failed to stop code execution"));
      throw error;
    } finally {
      this.codeCalls.delete(invocation);
    }
  }
  async codeTools(invocation: string): Promise<string[]> {
    if (!this.codeCalls.has(invocation)) throw new Error("No active code invocation");
    return [
      ...(this.execution.agent.tools ?? []).flatMap((tool) =>
        tool.type === "function" ? [tool.name] : [],
      ),
      ...(this.execution.sandbox ? Object.keys(workspaceTools) : []),
      ...this.remoteTools.tools.map((tool) => tool.codeName),
    ];
  }
  async codeTool(name: string, args: unknown, invocation: string): Promise<JsonValue> {
    if (!(await this.codeTools(invocation)).includes(name))
      throw new Error("Tool is not assigned to this code invocation");
    if (!codeEnabled(this.execution)) throw new Error("Programmatic tool calling is disabled");
    if (this.execution.sandbox && Object.hasOwn(workspaceTools, name)) {
      const result = await this.workspace(name as WorkspaceToolName, args);
      return {
        content: [{ type: "text", text: result.text }],
        isError: result.exitCode !== null && result.exitCode !== 0,
      };
    }
    if (this.remoteTools.tools.some((tool) => tool.codeName === name))
      return this.remoteTools.call(name, args);
    return this.externalTool(name, functionArguments(this.execution, name, args), invocation);
  }
  protected toolDefinitions(): Tool[] {
    const functions = (this.execution.agent.tools ?? []).flatMap((tool, index) =>
      tool.type !== "function" || tool.defer_loading
        ? []
        : [
            {
              name: `function_${index}`,
              description: `${tool.name}: ${tool.description}`,
              inputSchema: tool.parameters as { type: "object" },
            },
          ],
    );
    const search = this.execution.agent.tools?.some(
      (tool) => tool.type === "tool_search" || (tool.type === "function" && tool.defer_loading),
    );
    return [
      ...(codeEnabled(this.execution)
        ? [
            {
              ...programmaticTool,
              inputSchema: { ...programmaticTool.inputSchema, type: "object" as const },
            },
          ]
        : []),
      ...(this.execution.sandbox
        ? Object.entries(workspaceTools).map(([name, definition]) => ({
            name,
            description: definition.description,
            inputSchema: z.toJSONSchema(definition.schema, { io: "input" }) as { type: "object" },
          }))
        : []),
      ...functions,
      ...this.remoteTools.tools.map((tool) => tool.definition),
      ...this.delegations.definitions(),
      ...(search
        ? [
            {
              name: "cf_tool_search",
              description:
                "Find deferred function tools by name or description. Returns tool schemas to call with cf_call_tool.",
              inputSchema: {
                type: "object" as const,
                properties: { query: { type: "string" } },
                required: ["query"],
                additionalProperties: false,
              },
            },
            {
              name: "cf_call_tool",
              description: "Call a function previously discovered using cf_tool_search.",
              inputSchema: {
                type: "object" as const,
                properties: {
                  name: { type: "string" },
                  arguments: { type: "object", additionalProperties: true },
                },
                required: ["name", "arguments"],
                additionalProperties: false,
              },
            },
          ]
        : []),
    ];
  }
  /**
   * Route a native tool call. `scope` attributes the resulting events to a native
   * subagent; subagents cannot delegate or run code, which would nest execution
   * authority the Worker does not track.
   */
  protected async callTool(name: string, args: unknown, scope?: ToolScope) {
    if (scope && (name === programmaticTool.name || DELEGATION_TOOLS.has(name)))
      throw new Error("This tool is not available to subagents");
    if (name === programmaticTool.name && codeEnabled(this.execution))
      return this.executeCode(args);
    if (DELEGATION_TOOLS.has(name) && this.delegations.enabled)
      return this.delegations.call(name, args);
    if (name === "cf_tool_search") {
      const { query } = z.object({ query: z.string().min(1).max(1000) }).parse(args);
      const terms = query.toLowerCase().split(/\s+/);
      const tools = (this.execution.agent.tools ?? [])
        .filter(
          (tool) =>
            tool.type === "function" &&
            tool.defer_loading &&
            terms.some((term) => `${tool.name} ${tool.description}`.toLowerCase().includes(term)),
        )
        .slice(0, 20);
      for (const tool of tools) if (tool.type === "function") this.discovered.add(tool.name);
      return { content: [{ type: "text" as const, text: JSON.stringify(tools) }], isError: false };
    }
    if (name === "cf_call_tool") {
      const input = z.object({ name: z.string(), arguments: z.json() }).parse(args);
      const tool = this.execution.agent.tools?.find(
        (tool) => tool.type === "function" && tool.name === input.name,
      );
      if (tool?.type !== "function" || !this.discovered.has(tool.name))
        throw new Error("Discover the deferred tool before calling it");
      return this.externalTool(
        tool.name,
        z.fromJSONSchema(tool.parameters).parse(input.arguments),
        undefined,
        scope,
      );
    }
    if (Object.hasOwn(workspaceTools, name)) {
      const result = await this.workspace(name as WorkspaceToolName, args, scope);
      return {
        content: [{ type: "text" as const, text: result.text }],
        isError: result.exitCode !== null && result.exitCode !== 0,
      };
    }
    if (this.remoteTools.tools.some((tool) => tool.definition.name === name))
      return CallToolResultSchema.parse(await this.remoteTools.call(name, args, scope));
    const index = /^function_(\d+)$/.exec(name)?.[1];
    const tool = index === undefined ? undefined : this.execution.agent.tools?.[Number(index)];
    if (tool?.type !== "function" || tool.defer_loading) throw new Error("Unknown function tool");
    return this.externalTool(
      tool.name,
      z.fromJSONSchema(tool.parameters).parse(args),
      undefined,
      scope,
    );
  }
  async mcp(request: Request): Promise<Response> {
    const server = new Server(
      { name: "cf-workspace", version: "1" },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: this.toolDefinitions(),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (call) =>
      this.callTool(call.params.name, call.params.arguments),
    );
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    return runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.acquireRelease(Effect.succeed(server), (server) =>
            io("mcp.close", () => server.close()).pipe(Effect.orDie),
          );
          yield* io("mcp.connect", () => server.connect(transport));
          return yield* io("mcp.request", () => transport.handleRequest(request));
        }),
      ),
    );
  }
  control(operationId: string, command: RuntimeCommand): Promise<void> {
    return runPromise(
      Effect.gen(this, function* () {
        // Remote image parts are fetched before the memoized operation, so a transient
        // media failure stays retryable under the same operation ID.
        const content = command.type === "tool_result" ? yield* this.toolContent(command) : [];
        yield* this.operations.perform(
          operationId,
          command,
          this.lifecycle.transition.withPermits(1)(this.apply(operationId, command, content)),
        );
      }),
    );
  }
  private toolContent(command: Extract<RuntimeCommand, { type: "tool_result" }>) {
    const output = command.output;
    if (typeof output === "string")
      return Effect.succeed<ToolResult["content"]>([{ type: "text", text: output }]);
    return io("native.toolImages", () =>
      Promise.all(
        output.map(async (part): Promise<ToolResult["content"][number]> =>
          part.type === "input_text"
            ? { type: "text", text: part.text }
            : imageContent(part.image_url, this.abort.signal, this.options.mediaUrl),
        ),
      ),
    );
  }
  /**
   * `command_rejected` means the command can never apply to this execution; the
   * HarnessDO forwards it as such. Other failures are transient I/O errors.
   */
  private apply(operationId: string, command: RuntimeCommand, content: ToolResult["content"]) {
    return Effect.gen(this, function* () {
      const rejected = (message: string) => new ApiError(409, "command_rejected", message);
      if (command.type === "steer") {
        if (this.closing || !["running", "waiting"].includes(this.status))
          return yield* rejected("Turn is no longer active");
        return yield* io("native.steer", () => this.steer(command.input)).pipe(
          Effect.mapError((error) =>
            error instanceof OperationError && error.cause instanceof ApiError
              ? error.cause
              : error,
          ),
        );
      }
      if (command.type === "cancel") {
        // Idempotent: closing marks the outcome cancelled unless it is already terminal.
        yield* this.stopped;
        return;
      }
      const child = this.delegations.owns(command.callId);
      if (child) {
        // The result belongs to a delegated child's function call.
        if (this.closing) return yield* rejected("Execution has stopped");
        // A child the HarnessDO already closed can never take the result.
        yield* io("native.delegate", () =>
          this.delegations.routeToolResult(child, operationId, command),
        ).pipe(
          Effect.mapError((error) =>
            error instanceof OperationError && error.cause instanceof ApiError
              ? error.cause
              : error,
          ),
        );
        return;
      }
      if (this.closing || this.status !== "waiting")
        return yield* rejected("Execution is not waiting for tools");
      // Remove the call atomically: registrations that raced the image fetch survive.
      const entry = yield* Ref.modify(this.pending, (pending) => {
        const result = pending.get(command.callId);
        if (!result) return [undefined, pending] as const;
        const next = new Map(pending);
        next.delete(command.callId);
        return [{ result, remaining: next.size }, next] as const;
      });
      if (!entry) return yield* rejected("No matching pending function call");
      for (const raised of this.codeCalls.values()) raised.delete(command.callId);
      this.lifecycle.setStatus(entry.remaining ? "waiting" : "running");
      yield* Deferred.succeed(entry.result, { content, isError: !command.success });
    }).pipe(
      Effect.mapError((cause): ServiceError =>
        cause instanceof ApiError
          ? cause
          : new OperationError({ operation: "native.control", cause }),
      ),
    );
  }
  checkpoint(): Promise<NativeBundle> {
    return runPromise(this.saved);
  }
  stop(): Promise<void> {
    return runPromise(this.lifecycle.transition.withPermits(1)(this.stopped));
  }
}
