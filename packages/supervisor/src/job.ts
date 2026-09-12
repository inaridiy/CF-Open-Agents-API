import { mkdir, rm } from "node:fs/promises";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  type Execution,
  type RuntimeBatch,
  type RuntimeCommand,
  type RuntimeEvent,
  type WorkspaceToolName,
  workspaceResultSchema,
  workspaceTools,
} from "cf-open-agents-api";
import { z } from "zod";
import { capture, type NativeBundle, restore } from "./checkpoint.js";

export interface NativeJob {
  readonly execution: Execution;
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
  protected status: RuntimeBatch["status"] = "running";
  protected error?: string;
  protected sessionId = "";
  protected closing = false;
  protected readonly abort = new AbortController();
  protected task?: Promise<void>;
  private readonly events: RuntimeBatch["events"] = [];
  private eventBytes = 0;
  private readonly pending = new Map<
    string,
    {
      resolve(value: { content: { type: "text"; text: string }[]; isError: boolean }): void;
      reject(error: Error): void;
    }
  >();
  private readonly operations = new Map<string, Promise<void>>();
  private saved?: NativeBundle;
  abstract readonly home: string;
  constructor(
    readonly execution: Execution,
    protected readonly options: NativeOptions,
  ) {}
  abstract start(bundle?: unknown): Promise<void>;
  protected abstract closeRuntime(): Promise<void>;
  protected async prepare(bundle?: unknown): Promise<string | undefined> {
    await rm(this.home, { recursive: true, force: true });
    await mkdir(this.home, { recursive: true });
    return bundle ? restore(this.home, bundle) : undefined;
  }
  protected emit(event: RuntimeEvent): void {
    this.eventBytes += JSON.stringify(event).length;
    if (this.eventBytes > 8_000_000) throw new Error("Native event buffer exceeds its limit");
    this.events.push({ seq: this.events.length + 1, event });
  }
  protected run(task: () => Promise<void>): void {
    this.task = task()
      .then(() => {
        if (this.status === "running") this.status = "completed";
      })
      .catch((error) => {
        if (!this.closing && this.status !== "cancelled") this.failStart(error);
      });
  }
  failStart(_error: unknown): void {
    this.status = "failed";
    this.error = "native_harness_failed";
  }
  poll(after: number): RuntimeBatch {
    return {
      events: this.events.filter((event) => event.seq > after),
      cursor: this.events.length,
      status: this.status,
      ...(this.error ? { error: this.error } : {}),
    };
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
  protected async externalTool(name: string, args: unknown) {
    if (this.closing || this.abort.signal.aborted) throw new Error("Execution has stopped");
    const callId = `call_${crypto.randomUUID().replaceAll("-", "")}`;
    this.emit({ type: "function_call", id: callId, callId, name, arguments: z.json().parse(args) });
    this.status = "waiting";
    return new Promise<{ content: { type: "text"; text: string }[]; isError: boolean }>(
      (resolve, reject) => {
        this.pending.set(callId, { resolve, reject });
      },
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
    await server.connect(transport);
    try {
      return await transport.handleRequest(request);
    } finally {
      await server.close();
    }
  }
  async control(operationId: string, command: RuntimeCommand): Promise<void> {
    const previous = this.operations.get(operationId);
    if (previous) return previous;
    const operation = (async () => {
      if (command.type === "steer") throw new Error("This harness cannot steer an active turn");
      if (command.type === "cancel") {
        this.status = "cancelled";
        await this.stop();
        return;
      }
      const pending = this.pending.get(command.callId);
      if (!pending) throw new Error("No matching pending function call");
      this.pending.delete(command.callId);
      pending.resolve({
        content: [{ type: "text", text: command.output }],
        isError: !command.success,
      });
      if (!this.pending.size) this.status = "running";
    })();
    this.operations.set(operationId, operation);
    return operation;
  }
  async checkpoint(): Promise<NativeBundle> {
    if (this.saved) return this.saved;
    if (this.status !== "completed" || !this.sessionId)
      throw new Error("Native turn must complete before checkpointing");
    await this.stop();
    this.saved = await capture(this.home, this.sessionId);
    return this.saved;
  }
  async stop(): Promise<void> {
    this.closing = true;
    this.abort.abort();
    for (const pending of this.pending.values()) pending.reject(new Error("Execution stopped"));
    this.pending.clear();
    await this.closeRuntime();
    await this.task;
  }
}
