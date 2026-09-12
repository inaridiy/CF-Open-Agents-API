import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Execution, RuntimeBatch, RuntimeCommand, RuntimeEvent } from "cf-open-agents-api";
import { z } from "zod";
import { capture, type NativeBundle, restore } from "./checkpoint.js";
import { AppServer, type RpcMessage } from "./json-rpc.js";

const threadResponse = z.object({ thread: z.object({ id: z.string() }) });
const turnResponse = z.object({ turn: z.object({ id: z.string() }) });
const toolCall = z.object({ callId: z.string(), tool: z.string(), arguments: z.json() });
const completedItem = z.object({
  item: z.discriminatedUnion("type", [
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
    }),
  ]),
});

export interface CodexOptions {
  binary: string;
  directory: string;
  modelBaseUrl: string;
  sandboxUrl: string;
  diagnostics: (line: string) => void;
}

/** One instance per attempt. Workspace I/O goes through the remote environment. */
export class CodexJob {
  private server?: AppServer;
  private threadId = "";
  private nativeTurnId = "";
  private status: RuntimeBatch["status"] = "running";
  private error?: string;
  private seq = 0;
  private events: RuntimeBatch["events"] = [];
  private eventBytes = 0;
  private readonly pendingTools = new Map<string, string | number>();
  private readonly operations = new Map<string, Promise<void>>();
  private saved?: NativeBundle;
  private closing = false;
  readonly home: string;
  constructor(
    readonly execution: Execution,
    private readonly options: CodexOptions,
  ) {
    // Native SQLite stores absolute rollout paths. Keep CODEX_HOME stable across attempts.
    this.home = join(options.directory, "codex");
  }
  async start(bundle?: unknown): Promise<void> {
    await rm(this.home, { recursive: true, force: true });
    await mkdir(this.home, { recursive: true });
    const previousThread = bundle ? await restore(this.home, bundle) : null;
    await writeFile(
      join(this.home, "config.toml"),
      [
        'model_provider = "gateway"',
        `model = ${JSON.stringify(this.execution.model)}`,
        'approval_policy = "never"',
        'sandbox_mode = "danger-full-access"',
        'web_search = "disabled"',
        "[features]",
        "multi_agent = false",
        "plugins = false",
        "remote_plugin = false",
        "[model_providers.gateway]",
        'name = "Deployment model gateway"',
        `base_url = ${JSON.stringify(this.options.modelBaseUrl)}`,
        'wire_api = "responses"',
        "requires_openai_auth = false",
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
          this.status = "failed";
          this.error = "app_server_exited";
        }
      },
      onDiagnostic: this.options.diagnostics,
    });
    await this.server.request("initialize", {
      clientInfo: { name: "cf-open-agents-api", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    this.server.notify("initialized");
    const common = {
      model: this.execution.model,
      modelProvider: "gateway",
      cwd: this.options.directory,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      developerInstructions: this.execution.agent.instructions ?? null,
    };
    const result = previousThread
      ? await this.server.request("thread/resume", { ...common, threadId: previousThread })
      : await this.server.request("thread/start", {
          ...common,
          dynamicTools: (this.execution.agent.tools ?? []).map((tool) => ({
            type: "function",
            name: tool.name,
            description: tool.description,
            inputSchema: tool.parameters,
          })),
          environments: this.execution.sandbox
            ? [{ environmentId: "sandbox", cwd: "/workspace" }]
            : [],
        });
    this.threadId = threadResponse.parse(result).thread.id;
    const turn = await this.server.request("turn/start", {
      threadId: this.threadId,
      input: this.input(this.execution.input),
      environments: this.execution.sandbox ? [{ environmentId: "sandbox", cwd: "/workspace" }] : [],
    });
    this.nativeTurnId = turnResponse.parse(turn).turn.id;
  }
  private input(messages: Execution["input"]) {
    return messages.flatMap((message) =>
      message.content.map((part) => ({ type: "text", text: part.text, text_elements: [] })),
    );
  }
  private push(event: RuntimeEvent): void {
    this.eventBytes += JSON.stringify(event).length;
    if (this.eventBytes > 8_000_000) {
      this.status = "failed";
      this.error = "event_buffer_limit";
      void this.stop();
      return;
    }
    this.events.push({ seq: ++this.seq, event });
  }
  private receive(message: RpcMessage): void {
    if (message.id !== undefined && message.method) {
      if (message.method === "item/tool/call") {
        const parsed = toolCall.safeParse(message.params);
        if (!parsed.success) {
          this.server?.reject(message.id);
          return;
        }
        this.pendingTools.set(parsed.data.callId, message.id);
        this.status = "waiting";
        this.push({
          type: "function_call",
          id: parsed.data.callId,
          callId: parsed.data.callId,
          name: parsed.data.tool,
          arguments: parsed.data.arguments,
        });
      } else this.server?.reject(message.id);
      return;
    }
    if (message.method === "item/agentMessage/delta") {
      const delta = z.object({ itemId: z.string(), delta: z.string() }).safeParse(message.params);
      if (delta.success)
        this.push({ type: "delta", id: delta.data.itemId, text: delta.data.delta });
    } else if (message.method === "item/completed") {
      const result = completedItem.safeParse(message.params);
      if (!result.success) return;
      const item = result.data.item;
      this.push(
        item.type === "agentMessage"
          ? { type: "text", id: item.id, text: item.text, phase: item.phase ?? "final_answer" }
          : {
              type: "command",
              id: item.id,
              command: item.command,
              output: item.aggregatedOutput ?? "",
              exitCode: item.exitCode ?? null,
            },
      );
    } else if (message.method === "turn/completed") {
      const result = z
        .object({
          turn: z.object({
            status: z.string(),
            error: z.object({ message: z.string() }).nullable().optional(),
          }),
        })
        .safeParse(message.params);
      if (!result.success) {
        this.status = "failed";
        this.error = "invalid_turn_event";
        return;
      }
      this.status =
        result.data.turn.status === "completed"
          ? "completed"
          : result.data.turn.status === "interrupted"
            ? "cancelled"
            : "failed";
      this.error = result.data.turn.error?.message;
    }
  }
  poll(after: number): RuntimeBatch {
    if (after > this.seq || after < 0) throw new Error("Invalid event cursor");
    this.events = this.events.filter((entry) => entry.seq > after);
    this.eventBytes = this.events.reduce(
      (size, entry) => size + JSON.stringify(entry.event).length,
      0,
    );
    return {
      events: this.events.slice(0, 128),
      cursor: this.events.slice(0, 128).at(-1)?.seq ?? after,
      status: this.events.length > 128 ? "running" : this.status,
      ...(this.error ? { error: this.error } : {}),
    };
  }
  control(id: string, command: RuntimeCommand): Promise<void> {
    const previous = this.operations.get(id);
    if (previous) return previous;
    const operation = this.apply(command);
    this.operations.set(id, operation);
    return operation;
  }
  private async apply(command: RuntimeCommand): Promise<void> {
    if (!this.server) throw new Error("App-server not started");
    if (command.type === "cancel") {
      if (["completed", "cancelled", "failed"].includes(this.status)) return;
      await this.server.request("turn/interrupt", {
        threadId: this.threadId,
        turnId: this.nativeTurnId,
      });
    } else if (command.type === "steer") {
      await this.server.request("turn/steer", {
        threadId: this.threadId,
        expectedTurnId: this.nativeTurnId,
        input: this.input(command.input),
      });
    } else {
      const requestId = this.pendingTools.get(command.callId);
      if (requestId === undefined) throw new Error("Unknown tool call");
      this.server.respond(requestId, {
        success: command.success,
        contentItems: [{ type: "inputText", text: command.output }],
      });
      this.pendingTools.delete(command.callId);
      this.status = this.pendingTools.size > 0 ? "waiting" : "running";
    }
  }
  failStart(error: unknown): void {
    this.status = "failed";
    this.error = error instanceof Error ? error.message : "app_server_start_failed";
  }
  async checkpoint(): Promise<NativeBundle> {
    if (this.status !== "completed") throw new Error("Only completed turns can be checkpointed");
    if (!this.saved) {
      await this.stop();
      this.saved = await capture(this.home, this.threadId);
    }
    return this.saved;
  }
  async stop(): Promise<void> {
    this.closing = true;
    await this.server?.stop();
  }
}
