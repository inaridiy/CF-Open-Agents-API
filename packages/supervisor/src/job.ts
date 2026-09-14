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
  type Execution,
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
import { Cause, Deferred, Effect, Exit, Fiber, Ref, Scope } from "effect";
import { z } from "zod";
import { capture, type NativeBundle, restore } from "./checkpoint.js";
import { DELEGATION_TOOLS, Delegations } from "./delegation.js";
import { JobLifecycle, Operations, once } from "./lifecycle.js";
import { imageContent } from "./media.js";
import { codeEnabled, executeCode, functionArguments } from "./programmatic.js";
import { RemoteTools } from "./remote-tools.js";
import { executeWorkspace } from "./workspace.js";

type ToolResult = {
  content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[];
  isError: boolean;
};

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
  private readonly codeInvocations = new Set<string>();
  private readonly saved = once("native.checkpoint", async () => {
    if (this.status !== "completed" || !this.sessionId)
      throw new Error("Native turn must complete before checkpointing");
    await this.stop();
    return capture(this.home, this.sessionId);
  });
  private readonly stopped = once("native.stop", async () => {
    this.lifecycle.close();
    // Children are told first, while this job can still reach its HarnessDO route.
    await this.delegations.cancelAll();
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
  protected async prepare(bundle?: unknown): Promise<string | undefined> {
    await rm(this.home, { recursive: true, force: true });
    await mkdir(this.home, { recursive: true });
    const previous = bundle ? await restore(this.home, bundle) : undefined;
    await this.remoteTools.open(this.execution);
    return previous;
  }
  protected emit(event: RuntimeEvent): void {
    this.lifecycle.emit(event);
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
            // The public error stays generic; the reason is kept in native diagnostics.
            if (!this.closing) {
              const squashed = Cause.squash(cause);
              const reason = squashed instanceof OperationError ? squashed.cause : squashed;
              this.options.diagnostics(
                `native_harness_failed: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`,
              );
            }
            this.failStart(new Error("native_harness_failed"));
          }),
        ),
        Effect.forkIn(this.scope),
      ),
    );
  }
  failStart(_error: unknown): void {
    this.lifecycle.fail("native_harness_failed");
  }
  poll(after: number): RuntimeBatch {
    return this.lifecycle.poll(after);
  }
  async workspace(
    name: WorkspaceToolName,
    args: unknown,
  ): Promise<{ text: string; exitCode: number | null }> {
    if (!this.execution.sandbox || this.closing || this.abort.signal.aborted)
      throw new Error("No active sandbox assignment");
    return executeWorkspace(this.options.sandboxUrl, name, args, this.abort.signal, (event) =>
      this.emit(event),
    );
  }

  protected externalTool(name: string, args: unknown): Promise<ToolResult> {
    return runPromise(
      Effect.gen(this, function* () {
        if (this.closing || this.abort.signal.aborted)
          return yield* Effect.fail(new Error("Execution has stopped"));
        const callId = `call_${crypto.randomUUID().replaceAll("-", "")}`;
        const result = yield* Deferred.make<ToolResult, Error>();
        yield* Ref.update(this.pending, (pending) => new Map(pending).set(callId, result));
        this.emit({
          type: "function_call",
          id: callId,
          callId,
          name,
          arguments: z.json().parse(args),
        });
        this.lifecycle.setStatus("waiting");
        return yield* Deferred.await(result);
      }),
    );
  }
  protected async executeCode(input: unknown) {
    const invocation = crypto.randomUUID();
    this.codeInvocations.add(invocation);
    try {
      const result = await executeCode(
        this.execution,
        input,
        this.abort.signal,
        this.options.programmaticUrl,
        invocation,
      );
      if (result.terminal || (result.isError && runSync(Ref.get(this.pending)).size))
        throw new Error("Code execution left unfinished tool calls");
      return result;
    } catch (error) {
      this.lifecycle.fail("programmatic_execution_uncertain");
      this.abort.abort();
      void this.stop().catch(() => this.options.diagnostics("Failed to stop code execution"));
      throw error;
    } finally {
      this.codeInvocations.delete(invocation);
    }
  }
  async codeTools(invocation: string): Promise<string[]> {
    if (!this.codeInvocations.has(invocation)) throw new Error("No active code invocation");
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
    return this.externalTool(name, functionArguments(this.execution, name, args));
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
  protected async callTool(name: string, args: unknown) {
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
      return this.externalTool(tool.name, z.fromJSONSchema(tool.parameters).parse(input.arguments));
    }
    if (Object.hasOwn(workspaceTools, name)) {
      const result = await this.workspace(name as WorkspaceToolName, args);
      return {
        content: [{ type: "text" as const, text: result.text }],
        isError: result.exitCode !== null && result.exitCode !== 0,
      };
    }
    if (this.remoteTools.tools.some((tool) => tool.definition.name === name))
      return CallToolResultSchema.parse(await this.remoteTools.call(name, args));
    const index = /^function_(\d+)$/.exec(name)?.[1];
    const tool = index === undefined ? undefined : this.execution.agent.tools?.[Number(index)];
    if (tool?.type !== "function" || tool.defer_loading) throw new Error("Unknown function tool");
    return this.externalTool(tool.name, z.fromJSONSchema(tool.parameters).parse(args));
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
      this.operations.perform(
        operationId,
        command,
        this.lifecycle.transition.withPermits(1)(
          Effect.gen(this, function* () {
            if (command.type === "steer")
              return yield* Effect.fail(new Error("This harness cannot steer an active turn"));
            if (command.type === "cancel") {
              this.lifecycle.setStatus("cancelled");
              yield* this.stopped;
              return;
            }
            const child = this.delegations.owns(command.callId);
            if (child) {
              // The result belongs to a delegated child's function call.
              if (this.closing) return yield* Effect.fail(new Error("Execution has stopped"));
              yield* io("native.delegate", () =>
                this.delegations.routeToolResult(child, operationId, command),
              );
              return;
            }
            if (this.closing || this.status !== "waiting")
              return yield* Effect.fail(new Error("Execution is not waiting for tools"));
            const pending = yield* Ref.get(this.pending);
            const result = pending.get(command.callId);
            if (!result) return yield* Effect.fail(new Error("No matching pending function call"));
            const content =
              typeof command.output === "string"
                ? [{ type: "text" as const, text: command.output }]
                : yield* io("native.toolImages", () =>
                    Promise.all(
                      (command.output as Exclude<typeof command.output, string>).map(
                        async (part) =>
                          part.type === "input_text"
                            ? { type: "text" as const, text: part.text }
                            : imageContent(
                                part.image_url,
                                this.abort.signal,
                                this.options.mediaUrl,
                              ),
                      ),
                    ),
                  );
            const next = new Map(pending);
            next.delete(command.callId);
            yield* Ref.set(this.pending, next);
            this.lifecycle.setStatus(next.size ? "waiting" : "running");
            yield* Deferred.succeed(result, {
              content,
              isError: !command.success,
            });
          }).pipe(
            Effect.mapError(
              (cause): ServiceError => new OperationError({ operation: "native.control", cause }),
            ),
          ),
        ),
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
