import type { ChildProcess } from "node:child_process";
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
  type ServiceError,
  type WorkspaceToolName,
  workspaceTools,
} from "cf-open-agents-api";
import {
  Cause,
  Data,
  Deferred,
  type Duration,
  Effect,
  ExecutionStrategy,
  Exit,
  FiberId,
  MutableRef,
  Option,
  Scope,
} from "effect";
import { z } from "zod";

import { capture, type NativeBundle, restore } from "./checkpoint.js";
import { DELEGATION_TOOLS, type DelegationOptions, Delegations } from "./delegation.js";
import {
  CheckpointUnavailable,
  describeFailure,
  ExecutionStopped,
  type InvalidCursor,
  JobLog,
  once,
  Operations,
  Wake,
} from "./lifecycle.js";
import { imageContent } from "./media.js";
import { ownProcess } from "./process.js";
import { codeEnabled, executeCode, functionArguments } from "./programmatic.js";
import { RemoteTools } from "./remote-tools.js";
import { executeWorkspace } from "./workspace.js";

export type ToolResult = {
  content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[];
  isError: boolean;
};

/** Attribution of events raised on behalf of a native subagent. */
export interface ToolScope {
  subagentId: string;
  turnId: string;
}

/** A tool the caller named cannot be called from here; the message says why. */
export class ToolUnavailable extends Data.TaggedError("ToolUnavailable")<{
  readonly message: string;
}> {}
export type ToolError = ToolUnavailable | ServiceError;

export interface NativeJob {
  readonly execution: Execution;
  readonly status: RuntimeBatch["status"];
  start(bundle?: unknown): Effect.Effect<void, ServiceError>;
  /** Events after `after`; with `wait`, blocks up to that long for news unless the outcome is terminal. */
  poll(after: number, wait?: Duration.DurationInput): Effect.Effect<RuntimeBatch, InvalidCursor>;
  control(operationId: string, command: RuntimeCommand): Effect.Effect<void, ServiceError>;
  checkpoint(): Effect.Effect<NativeBundle, ServiceError>;
  stop(): Effect.Effect<void>;
  failStart(error: unknown): void;
  mcp?(request: Request): Effect.Effect<Response, ServiceError>;
  codeTool?(name: string, args: unknown, invocation: string): Effect.Effect<JsonValue, ToolError>;
  codeTools?(invocation: string): Effect.Effect<string[], ToolError>;
  workspace?(
    name: WorkspaceToolName,
    args: unknown,
  ): Effect.Effect<{ text: string; exitCode: number | null }, ServiceError>;
}

/** What every native runtime needs from its deployment. */
export interface JobOptions {
  directory: string;
  sandboxUrl: string;
  diagnostics: (line: string) => void;
  programmaticUrl?: string;
  delegateUrl?: string;
  /** Bounds for delegate round trips; tests shorten them. */
  delegationTimeouts?: DelegationOptions["timeouts"];
}
export interface NativeOptions extends JobOptions {
  modelBaseUrl: string;
  supervisorUrl: string;
  opencodeBinary: string;
  mediaUrl?: string;
}

const toServiceError =
  (operation: string) =>
  (cause: unknown): ServiceError =>
    cause instanceof ApiError ? cause : new OperationError({ operation, cause });

/**
 * Lifecycle shared by every native runtime. `start` creates the job's Scope and
 * registers the stop sequence as finalizers; every process, fiber and relay is
 * acquired into a child scope that closes last. `stop()` closes the Scope, so the
 * order below is the only definition of shutdown:
 *
 *   requestCancel → delegations.cancelAll → interruptTurn → log sealed → abort →
 *   pending calls failed → teardown (remote tools, runtime closed) → resources closed
 *   (task and relay fibers interrupted and awaited, processes terminated).
 *
 * Native SDK callbacks run outside any fiber; `perform` hands their Effects to a
 * worker fiber the resource scope owns, so stopping interrupts them for real.
 */
export abstract class Job<Prepared = void> implements NativeJob {
  protected readonly lifecycle = new JobLog();
  protected readonly abort = new AbortController();
  protected readonly delegations: Delegations;
  abstract readonly home: string;
  private readonly transition = Effect.unsafeMakeSemaphore(1);
  private readonly operations = new Operations();
  /** The job's Scope, created by `start`; `stop` closes it. */
  private readonly owner = MutableRef.make(Option.none<Scope.CloseableScope>());
  /** Child scope holding the runtime, its fibers and relays; closed last. */
  private readonly resources = MutableRef.make(Option.none<Scope.CloseableScope>());
  private readonly inbox = MutableRef.make<Effect.Effect<void, never, Scope.Scope>[]>([]);
  private readonly wake = new Wake();
  /** Completed by a native callback that needs the job stopped; a daemon fiber runs the stop. */
  private readonly stopRequested = Deferred.unsafeMake<void>(FiberId.none);
  constructor(
    readonly execution: Execution,
    protected readonly options: JobOptions,
  ) {
    this.delegations = new Delegations(execution, {
      endpoint: options.delegateUrl ?? "http://delegate.internal",
      signal: this.abort.signal,
      emit: (event) => this.emit(event),
      fail: (error) => {
        this.lifecycle.fail(error);
        this.requestStop();
      },
      settled: () => this.settled(),
      diagnostics: (line) => options.diagnostics(line),
      ...(options.delegationTimeouts ? { timeouts: options.delegationTimeouts } : {}),
    });
  }
  get status() {
    return this.lifecycle.status;
  }
  protected get closing() {
    return this.lifecycle.closing;
  }
  protected get cancelling() {
    return this.lifecycle.cancelling;
  }
  /** Native thread/session identifier a checkpoint records; undefined until known. */
  protected abstract get thread(): string | undefined;
  /** Bring the runtime up inside the resource Scope: processes, consumers, relays. */
  protected abstract acquire(bundle?: unknown): Effect.Effect<void, unknown, Scope.Scope>;
  /** Ask the runtime to end the turn gracefully before the log seals; bounded by the implementation. */
  protected interruptTurn(): Effect.Effect<void, unknown> {
    return Effect.void;
  }
  /** Fail calls still waiting on a client result; runs after the log is sealed. */
  protected abandon(): void {}
  /** Close what `acquire` opened outside the resource Scope; runs before that Scope closes. */
  protected teardown(): Effect.Effect<void, unknown> {
    return Effect.void;
  }
  /** Runs after the runtime has stopped and before the home is captured. */
  protected beforeCapture(): Effect.Effect<void, unknown> {
    return Effect.void;
  }
  /** A delegated child reached a terminal status. */
  protected settled(): void {}
  /** Work done before the memoized operation, so a transient failure stays retryable under the same ID. */
  protected abstract prepareCommand(command: RuntimeCommand): Effect.Effect<Prepared, ServiceError>;
  /**
   * `command_rejected` means the command can never apply to this execution; the
   * HarnessDO forwards it as such. Other failures are transient I/O errors.
   */
  protected abstract apply(
    operationId: string,
    command: RuntimeCommand,
    prepared: Prepared,
  ): Effect.Effect<void, unknown>;

  start(bundle?: unknown): Effect.Effect<void, ServiceError> {
    return this.transition.withPermits(1)(
      Effect.gen(this, function* () {
        if (this.closing) return yield* new ExecutionStopped();
        const scope = yield* Scope.make();
        MutableRef.set(this.owner, Option.some(scope));
        yield* Scope.extend(this.bringUp(bundle), scope);
        // A stop requested from a native callback must not run on a fiber the stop
        // interrupts, so it gets its own; it ends as soon as the job has stopped.
        yield* Deferred.await(this.stopRequested).pipe(
          Effect.zipRight(this.stop()),
          Effect.forkDaemon,
        );
      }).pipe(
        Effect.onError((cause) =>
          Effect.sync(() => this.failStart(cause)).pipe(Effect.zipRight(this.stopped)),
        ),
        Effect.mapError(toServiceError("native.start")),
      ),
    );
  }
  /** Finalizers run in reverse registration order: read this list bottom-up for the stop sequence. */
  private bringUp(bundle?: unknown): Effect.Effect<void, unknown, Scope.Scope> {
    return Effect.gen(this, function* () {
      const resources = yield* Scope.fork(yield* Effect.scope, ExecutionStrategy.sequential);
      yield* Effect.addFinalizer(() => this.teardown().pipe(this.diagnosed("teardown")));
      yield* Effect.addFinalizer(() => Effect.sync(() => this.abandon()));
      yield* Effect.addFinalizer(() => Effect.sync(() => this.abort.abort()));
      yield* Effect.addFinalizer(() => Effect.sync(() => this.lifecycle.close()));
      yield* Effect.addFinalizer(() => this.interruptTurn().pipe(this.diagnosed("interrupt")));
      yield* Effect.addFinalizer(() => this.delegations.cancelAll());
      yield* Effect.addFinalizer(() => Effect.sync(() => this.lifecycle.requestCancel()));
      MutableRef.set(this.resources, Option.some(resources));
      yield* Scope.extend(this.worker.pipe(Effect.forkScoped), resources);
      yield* Scope.extend(this.acquire(bundle), resources);
    });
  }
  private diagnosed(step: string) {
    return <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<void> =>
      effect.pipe(
        Effect.asVoid,
        Effect.catchAllCause((cause) =>
          Effect.sync(() => this.options.diagnostics(`${step} failed: ${describeFailure(cause)}`)),
        ),
      );
  }
  /** Runs Effects handed over from callback land; each becomes a child fiber of this worker. */
  private readonly worker = Effect.forever(
    Effect.gen(this, function* () {
      const woken = this.wake.wait();
      const items = MutableRef.getAndSet(this.inbox, []);
      yield* Effect.forEach(items, (item) => Effect.fork(item), { discard: true });
      yield* woken;
    }),
  );
  /**
   * Run an Effect on behalf of a native callback (an SDK tool handler, a JSON-RPC
   * request) as a fiber owned by this job's resources. Stopping the job interrupts
   * it; the Promise then rejects with the squashed cause.
   */
  protected perform<A, E>(effect: Effect.Effect<A, E, Scope.Scope>): Promise<A> {
    const { promise, resolve, reject } = Promise.withResolvers<A>();
    if (this.closing || Option.isNone(MutableRef.get(this.resources))) {
      reject(new ExecutionStopped());
      return promise;
    }
    MutableRef.update(this.inbox, (items) => [
      ...items,
      effect.pipe(
        Effect.onExit((exit) =>
          Effect.sync(() =>
            Exit.match(exit, {
              onFailure: (cause) => reject(Cause.squash(cause)),
              onSuccess: resolve,
            }),
          ),
        ),
        Effect.ignore,
      ),
    ]);
    this.wake.notify();
    return promise;
  }
  /** Terminate a process the runtime spawned when this job's resources close. */
  protected own(child: ChildProcess, grace: Duration.DurationInput): Promise<void> {
    return this.perform(ownProcess(child, grace).pipe(Effect.asVoid));
  }
  /** The native turn: completion waits for delegated children, like native Codex children. */
  protected run(task: () => Promise<void>): void {
    void this.perform(
      io("native.run", () => task()).pipe(
        Effect.zipRight(this.delegations.settle()),
        Effect.tap(() => Effect.sync(() => this.lifecycle.setStatus("completed"))),
        Effect.catchAllCause((cause) =>
          Effect.sync(() => {
            // A stop interrupts the task deliberately; that is not a harness failure.
            if (!this.closing) this.failStart(cause);
          }),
        ),
      ),
    ).catch(() => {});
  }
  private readonly stopped: Effect.Effect<void> = once(
    Effect.gen(this, function* () {
      const scope = MutableRef.get(this.owner);
      // Never started: nothing to release, but the log seals so late results are refused.
      if (Option.isSome(scope))
        yield* Scope.close(scope.value, Exit.void).pipe(this.diagnosed("stop"));
      else this.lifecycle.close();
      yield* Deferred.complete(this.stopRequested, Effect.void);
    }),
  );
  stop(): Effect.Effect<void> {
    return this.transition.withPermits(1)(this.stopped);
  }
  /** Stop from callback land; the daemon forked by `start` performs it. */
  protected requestStop(): void {
    Deferred.unsafeDone(this.stopRequested, Effect.void);
  }
  private readonly saved = once(
    Effect.gen(this, function* () {
      const thread = this.thread;
      if (this.status !== "completed" || !thread)
        return yield* new CheckpointUnavailable({
          reason: "Native turn must complete before checkpointing",
        });
      yield* this.stop();
      yield* this.beforeCapture();
      return yield* capture(this.home, thread);
    }).pipe(Effect.mapError(toServiceError("native.checkpoint"))),
  );
  checkpoint(): Effect.Effect<NativeBundle, ServiceError> {
    return this.saved;
  }
  control(operationId: string, command: RuntimeCommand): Effect.Effect<void, ServiceError> {
    return Effect.gen(this, function* () {
      const prepared = yield* this.prepareCommand(command);
      yield* this.operations.perform(
        operationId,
        command,
        this.transition.withPermits(1)(
          this.apply(operationId, command, prepared).pipe(
            Effect.mapError(toServiceError("native.control")),
          ),
        ),
      );
    });
  }
  /** Cancel under the transition permit: the memoized cancel command joins any stop in flight. */
  protected get cancel(): Effect.Effect<void> {
    return this.stopped;
  }
  poll(after: number, wait?: Duration.DurationInput) {
    return this.lifecycle.poll(after, wait);
  }
  /** The public error is a stable code; the native reason goes to diagnostics. */
  failStart(error: unknown): void {
    this.options.diagnostics(`native_harness_failed: ${describeFailure(error)}`);
    this.lifecycle.fail("native_harness_failed");
  }
  /** Exceeding the retained event budget fails the job; the runtime is then stopped. */
  protected emit(event: RuntimeEvent): void {
    if (!this.lifecycle.emit(event) && this.status === "failed" && !this.closing)
      this.requestStop();
  }
}

/** The client-tool bridge shared by the SDK-driven runtimes; inference remains in the native harness. */
export abstract class ToolJob extends Job<ToolResult["content"]> {
  protected sessionId = "";
  protected readonly remoteTools = new RemoteTools(this.abort.signal, (event) => this.emit(event));
  private readonly pending = new Map<string, Deferred.Deferred<ToolResult, ExecutionStopped>>();
  private readonly discovered = new Set<string>();
  /** Client function calls raised by each live code invocation; settled calls leave the set. */
  private readonly codeCalls = new Map<string, Set<string>>();
  constructor(
    execution: Execution,
    protected override readonly options: NativeOptions,
  ) {
    super(execution, options);
  }
  protected get thread() {
    return this.sessionId || undefined;
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
  protected acquire(bundle?: unknown) {
    return io("native.open", () => this.open(bundle));
  }
  /** Reset the native home, restore a checkpoint into it and connect remote MCP tools. */
  protected async prepare(bundle?: unknown): Promise<string | undefined> {
    await rm(this.home, { recursive: true, force: true });
    await mkdir(this.home, { recursive: true });
    const previous = bundle ? await this.perform(restore(this.home, bundle)) : undefined;
    await this.remoteTools.open(this.execution);
    return previous;
  }
  protected override interruptTurn() {
    return io("native.interrupt", () => this.interruptRuntime());
  }
  protected override abandon(): void {
    const failure = Effect.fail(new ExecutionStopped());
    for (const result of this.pending.values()) Deferred.unsafeDone(result, failure);
    this.pending.clear();
  }
  protected override teardown() {
    return Effect.gen(this, function* () {
      yield* io("native.remoteTools.close", () => this.remoteTools.close());
      yield* io("native.close", () => this.closeRuntime());
    });
  }
  private async runWorkspace(
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
  workspace(name: WorkspaceToolName, args: unknown) {
    return io("native.workspace", () => this.runWorkspace(name, args));
  }
  /** Raise a client function call; the Promise settles with the routed result or the stop. */
  protected externalTool(
    name: string,
    args: unknown,
    invocation?: string,
    scope?: ToolScope,
  ): Promise<ToolResult> {
    if (this.closing || this.abort.signal.aborted) return Promise.reject(new ExecutionStopped());
    const callId = `call_${crypto.randomUUID().replaceAll("-", "")}`;
    const result = Deferred.unsafeMake<ToolResult, ExecutionStopped>(FiberId.none);
    this.pending.set(callId, result);
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
    return this.perform(Deferred.await(result));
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
      this.requestStop();
      throw error;
    } finally {
      this.codeCalls.delete(invocation);
    }
  }
  codeTools(invocation: string): Effect.Effect<string[], ToolUnavailable> {
    return Effect.suspend(() =>
      this.codeCalls.has(invocation)
        ? Effect.succeed([
            ...(this.execution.agent.tools ?? []).flatMap((tool) =>
              tool.type === "function" ? [tool.name] : [],
            ),
            ...(this.execution.sandbox ? Object.keys(workspaceTools) : []),
            ...this.remoteTools.tools.map((tool) => tool.codeName),
          ])
        : new ToolUnavailable({ message: "No active code invocation" }),
    );
  }
  codeTool(name: string, args: unknown, invocation: string): Effect.Effect<JsonValue, ToolError> {
    return Effect.gen(this, function* () {
      if (!(yield* this.codeTools(invocation)).includes(name))
        return yield* new ToolUnavailable({
          message: "Tool is not assigned to this code invocation",
        });
      if (!codeEnabled(this.execution))
        return yield* new ToolUnavailable({ message: "Programmatic tool calling is disabled" });
      if (this.execution.sandbox && Object.hasOwn(workspaceTools, name)) {
        const result = yield* this.workspace(name as WorkspaceToolName, args);
        return {
          content: [{ type: "text", text: result.text }],
          isError: result.exitCode !== null && result.exitCode !== 0,
        };
      }
      if (this.remoteTools.tools.some((tool) => tool.codeName === name))
        return yield* io("native.remoteTool", () => this.remoteTools.call(name, args));
      return yield* io("native.codeTool", () =>
        this.externalTool(name, functionArguments(this.execution, name, args), invocation),
      );
    });
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
      return this.perform(this.delegations.call(name, args));
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
      const result = await this.runWorkspace(name as WorkspaceToolName, args, scope);
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
  mcp(request: Request): Effect.Effect<Response, ServiceError> {
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
    return Effect.scoped(
      Effect.gen(function* () {
        yield* Effect.acquireRelease(Effect.succeed(server), (server) =>
          io("mcp.close", () => server.close()).pipe(Effect.orDie),
        );
        yield* io("mcp.connect", () => server.connect(transport));
        return yield* io("mcp.request", () => transport.handleRequest(request));
      }),
    );
  }
  /**
   * Remote image parts are fetched before the memoized operation, so a transient
   * media failure stays retryable under the same operation ID.
   */
  protected prepareCommand(command: RuntimeCommand) {
    if (command.type !== "tool_result") return Effect.succeed<ToolResult["content"]>([]);
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
  protected apply(operationId: string, command: RuntimeCommand, content: ToolResult["content"]) {
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
        yield* this.cancel;
        return;
      }
      const child = this.delegations.owns(command.callId);
      if (child) {
        // The result belongs to a delegated child's function call.
        if (this.closing) return yield* rejected("Execution has stopped");
        // A child the HarnessDO already closed can never take the result.
        yield* this.delegations.routeToolResult(child, operationId, command);
        return;
      }
      if (this.closing || this.status !== "waiting")
        return yield* rejected("Execution is not waiting for tools");
      // Remove the call atomically: registrations that raced the image fetch survive.
      const result = this.pending.get(command.callId);
      if (!result) return yield* rejected("No matching pending function call");
      this.pending.delete(command.callId);
      for (const raised of this.codeCalls.values()) raised.delete(command.callId);
      this.lifecycle.setStatus(this.pending.size ? "waiting" : "running");
      yield* Deferred.succeed(result, { content, isError: !command.success });
    });
  }
}
