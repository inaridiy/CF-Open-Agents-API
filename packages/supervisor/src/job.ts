import { mkdir, rm } from "node:fs/promises";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  type Execution,
  io,
  OperationError,
  type RuntimeBatch,
  type RuntimeCommand,
  type RuntimeEvent,
  runPromise,
  runSync,
  type ServiceError,
  type WorkspaceToolName,
  workspaceResultSchema,
  workspaceTools,
} from "cf-open-agents-api";
import { Deferred, Effect, Exit, Fiber, Ref, Scope } from "effect";
import { z } from "zod";
import { capture, type NativeBundle, restore } from "./checkpoint.js";
import { JobLifecycle, Operations, once } from "./lifecycle.js";

type ToolResult = { content: { type: "text"; text: string }[]; isError: boolean };

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
  private readonly saved = once("native.checkpoint", async () => {
    if (this.status !== "completed" || !this.sessionId)
      throw new Error("Native turn must complete before checkpointing");
    await this.stop();
    return capture(this.home, this.sessionId);
  });
  private readonly stopped = once("native.stop", async () => {
    this.lifecycle.close();
    this.abort.abort();
    const pending = runSync(Ref.getAndSet(this.pending, new Map()));
    for (const result of pending.values())
      runSync(Deferred.fail(result, new Error("Execution stopped")));
    await this.closeRuntime();
    await runPromise(Scope.close(this.scope, Exit.void));
    if (this.task) await runPromise(Fiber.await(this.task));
  });
  abstract readonly home: string;
  constructor(
    readonly execution: Execution,
    protected readonly options: NativeOptions,
  ) {}
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
    return bundle ? restore(this.home, bundle) : undefined;
  }
  protected emit(event: RuntimeEvent): void {
    this.lifecycle.emit(event);
  }
  protected run(task: () => Promise<void>): void {
    this.task = runSync(
      io("native.run", task).pipe(
        Effect.tap(() => Effect.sync(() => this.lifecycle.setStatus("completed"))),
        Effect.catchAllCause(() =>
          Effect.sync(() => this.failStart(new Error("native_harness_failed"))),
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
    const input = workspaceTools[name].schema.parse(args);
    const response = await fetch(
      `${this.options.sandboxUrl.replace(/^ws/, "http").replace(/\/$/, "")}/tools`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tool: name, arguments: input }),
        signal: this.abort.signal,
      },
    );
    if (!response.ok) throw new Error(`Sandbox operation failed (${response.status})`);
    const result = workspaceResultSchema.parse(await response.json());
    if (name === "bash")
      this.emit({
        type: "command",
        id: crypto.randomUUID(),
        command: (input as { command: string }).command,
        output: result.text,
        exitCode: result.exitCode,
      });
    return result;
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
  async mcp(request: Request): Promise<Response> {
    const server = new Server(
      { name: "cf-workspace", version: "1" },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        ...(this.execution.sandbox
          ? Object.entries(workspaceTools).map(([name, definition]) => ({
              name,
              description: definition.description,
              inputSchema: z.toJSONSchema(definition.schema, { io: "input" }) as { type: "object" },
            }))
          : []),
        ...(this.execution.agent.tools ?? []).map((tool, index) => ({
          name: `function_${index}`,
          description: `${tool.name}: ${tool.description}`,
          inputSchema: tool.parameters as { type: "object" },
        })),
      ],
    }));
    server.setRequestHandler(CallToolRequestSchema, async (call) => {
      if (Object.hasOwn(workspaceTools, call.params.name)) {
        const result = await this.workspace(
          call.params.name as WorkspaceToolName,
          call.params.arguments,
        );
        return {
          content: [{ type: "text", text: result.text }],
          isError: result.exitCode !== null && result.exitCode !== 0,
        };
      }
      const index = /^function_(\d+)$/.exec(call.params.name)?.[1];
      const definition =
        index === undefined ? undefined : this.execution.agent.tools?.[Number(index)];
      if (!definition) throw new Error("Unknown function tool");
      return this.externalTool(definition.name, call.params.arguments);
    });
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
            if (this.closing || this.status !== "waiting")
              return yield* Effect.fail(new Error("Execution is not waiting for tools"));
            const pending = yield* Ref.get(this.pending);
            const result = pending.get(command.callId);
            if (!result) return yield* Effect.fail(new Error("No matching pending function call"));
            const next = new Map(pending);
            next.delete(command.callId);
            yield* Ref.set(this.pending, next);
            this.lifecycle.setStatus(next.size ? "waiting" : "running");
            yield* Deferred.succeed(result, {
              content: [{ type: "text" as const, text: command.output }],
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
