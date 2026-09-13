import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Execution, RuntimeBatch, RuntimeCommand, RuntimeEvent } from "cf-open-agents-api";
import { io, runPromise, runSync } from "cf-open-agents-api";
import { Effect, Ref } from "effect";
import { z } from "zod";
import { capture, type NativeBundle, restore } from "./checkpoint.js";
import { AppServer, type RpcMessage } from "./json-rpc.js";
import { JobLifecycle, Operations, once } from "./lifecycle.js";

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
  private readonly lifecycle = new JobLifecycle();
  get status() {
    return this.lifecycle.status;
  }
  private get closing() {
    return this.lifecycle.closing;
  }
  private readonly pendingTools = Ref.unsafeMake(new Map<string, string | number>());
  private readonly operations = new Operations();
  private readonly saved = once("codex.checkpoint", async () => {
    if (this.status !== "completed") throw new Error("Only completed turns can be checkpointed");
    await this.stop();
    return capture(this.home, this.threadId);
  });
  private readonly stopped = once("codex.stop", async () => {
    this.lifecycle.close();
    await this.server?.stop();
  });
  readonly home: string;
  constructor(
    readonly execution: Execution,
    private readonly options: CodexOptions,
  ) {
    // Native SQLite stores absolute rollout paths. Keep CODEX_HOME stable across attempts.
    this.home = join(options.directory, "codex");
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
          this.lifecycle.fail("app_server_exited");
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
    try {
      this.lifecycle.emit(event);
    } catch {
      this.lifecycle.fail("event_buffer_limit");
      void this.stop().catch(this.options.diagnostics);
    }
  }
  private receive(message: RpcMessage): void {
    if (this.closing || !["running", "waiting"].includes(this.status)) return;
    if (message.id !== undefined && message.method) {
      if (message.method === "item/tool/call") {
        const parsed = toolCall.safeParse(message.params);
        if (!parsed.success) {
          this.server?.reject(message.id);
          return;
        }
        runSync(
          Ref.update(this.pendingTools, (pending) =>
            new Map(pending).set(parsed.data.callId, message.id as number | string),
          ),
        );
        this.lifecycle.setStatus("waiting");
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
        this.lifecycle.fail("invalid_turn_event");
        return;
      }
      if (result.data.turn.status === "completed") this.lifecycle.setStatus("completed");
      else if (result.data.turn.status === "interrupted") this.lifecycle.setStatus("cancelled");
      else this.lifecycle.fail(result.data.turn.error?.message ?? "native_turn_failed");
    }
  }
  poll(after: number): RuntimeBatch {
    return this.lifecycle.poll(after);
  }
  control(id: string, command: RuntimeCommand): Promise<void> {
    return runPromise(
      this.operations.perform(
        id,
        command,
        this.lifecycle.transition.withPermits(1)(io("codex.control", () => this.apply(command))),
      ),
    );
  }
  private async apply(command: RuntimeCommand): Promise<void> {
    if (!this.server) throw new Error("App-server not started");
    if (
      command.type !== "cancel" &&
      (this.closing || !["running", "waiting"].includes(this.status))
    )
      throw new Error("Turn is no longer active");
    if (command.type === "cancel") {
      if (["completed", "cancelled", "failed"].includes(this.status)) return;
      await this.server.request("turn/interrupt", {
        threadId: this.threadId,
        turnId: this.nativeTurnId,
      });
    } else if (command.type === "steer") {
      if (this.closing || !["running", "waiting"].includes(this.status))
        throw new Error("Turn is no longer steerable");
      await this.server.request("turn/steer", {
        threadId: this.threadId,
        expectedTurnId: this.nativeTurnId,
        input: this.input(command.input),
      });
    } else {
      const requestId = runSync(Ref.get(this.pendingTools)).get(command.callId);
      if (requestId === undefined) throw new Error("Unknown tool call");
      this.server.respond(requestId, {
        success: command.success,
        contentItems: [{ type: "inputText", text: command.output }],
      });
      const remaining = runSync(
        Ref.updateAndGet(this.pendingTools, (pending) => {
          const next = new Map(pending);
          next.delete(command.callId);
          return next;
        }),
      );
      this.lifecycle.setStatus(remaining.size ? "waiting" : "running");
    }
  }
  failStart(error: unknown): void {
    this.lifecycle.fail(error instanceof Error ? error.message : "app_server_start_failed");
  }
  checkpoint(): Promise<NativeBundle> {
    return runPromise(this.saved);
  }
  stop(): Promise<void> {
    return runPromise(this.lifecycle.transition.withPermits(1)(this.stopped));
  }
}
