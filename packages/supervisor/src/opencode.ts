import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";

import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import type {
  AssistantMessage,
  Config,
  Event,
  Message,
  Part,
  ToolPart,
} from "@opencode-ai/sdk/v2/types";
import {
  type Execution,
  type InputMessage,
  io,
  OperationError,
  type RuntimeEvent,
} from "cf-open-agents-api";
import { Deferred, Effect, Option } from "effect";

import { Buffer } from "./buffer.js";
import { type NativeOptions, ToolJob } from "./job.js";
import {
  CommandRejected,
  describeFailure,
  statusToTurnCode,
  terminal,
  type TurnErrorCode,
  Wake,
  within,
} from "./lifecycle.js";
import { imageContent } from "./media.js";
import { type ChildState, type EventScope, OpenCodeTranscript } from "./opencode-transcript.js";
import { awaitReady, NativeExited, NativeStartupFailed, NativeTurnFailed } from "./process.js";

type Client = ReturnType<typeof createOpencodeClient>;
/** The part of the client `untilIdle` reads, so a test can stand in for the server. */
export type StatusClient = {
  session: {
    status: (request: object, options: { signal: AbortSignal }) => Promise<{ data?: unknown }>;
  };
};
type PromptRequest = Parameters<Client["session"]["prompt"]>[0];
type PromptParts = NonNullable<PromptRequest["parts"]>;
type OutputFormat = NonNullable<PromptRequest["format"]>;
type Permission = "allow" | "deny";

/** OpenCode provider variants carry the reasoning effort the gateway forwards upstream. */
const EFFORT_VARIANTS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
/** The general-purpose agent native `task` calls delegate to. */
const SUBAGENT = "cf-subagent";
/** Native OpenCode names MCP tools `<server>_<tool>`; the workspace server hosts ours. */
const WORKSPACE_PREFIX = "workspace_";
/** The synthetic tool OpenCode adds for json_schema output; the wildcard deny must not strip it. */
const STRUCTURED_OUTPUT = "StructuredOutput";
/** Time allowed for the server to report that it is listening. */
const STARTUP_BOUND = "30 seconds";
/** Time allowed for the event feed to echo a barrier before the turn goes on without it. */
const BARRIER_BOUND = "10 seconds";

const RUNTIME = "opencode";

interface RunningTool {
  readonly sessionId: string;
  readonly tool: string;
  readonly input: string;
}

/** Maps a native OpenCode failure to the public turn error code; detail stays in diagnostics. */
export function opencodeTurnError(error: NonNullable<AssistantMessage["error"]>): {
  code: TurnErrorCode;
  detail: string;
} {
  const data = error.data as Record<string, unknown>;
  const message = typeof data.message === "string" ? data.message : JSON.stringify(data);
  switch (error.name) {
    case "ProviderAuthError":
      return { code: "authentication_error", detail: message };
    case "ContextOverflowError":
      return { code: "context_length_exceeded", detail: message };
    case "ContentFilterError":
      return { code: "cyber_policy", detail: message };
    case "MessageOutputLengthError":
      return {
        code: "internal_error",
        detail: `Model output exceeded its length limit: ${message}`,
      };
    case "StructuredOutputError":
      return {
        code: "internal_error",
        detail: `Model did not produce output matching the requested schema after ${typeof data.retries === "number" ? data.retries : 0} retries: ${message}`,
      };
    case "APIError": {
      // OpenCode retries retryable statuses (429, 5xx, connection failures) up to five
      // times, honoring retry-after headers, before this error reaches the message.
      // An `APIError` without a status is OpenCode reporting that it never reached
      // the provider; a status the table does not recognise is still a server error.
      const status = typeof data.statusCode === "number" ? data.statusCode : undefined;
      const code =
        status === undefined ? "connection_failed" : (statusToTurnCode(status) ?? "server_error");
      return { code, detail: `${status ?? "network"}: ${message}` };
    }
    default:
      return { code: "internal_error", detail: message };
  }
}

export class OpenCodeJob extends ToolJob {
  readonly home: string;
  private client?: Client;
  private format?: OutputFormat;
  private variant?: string;
  /** Session-level tool rules: allows only, so task children inherit no wildcard deny. */
  private promptTools: Record<string, boolean> = {};
  /** Steered user messages stored in the session, keyed by their OpenCode message ID. */
  private readonly steered = new Map<string, PromptParts>();
  /** Serializes steer admission against the turn's settlement check. */
  private readonly gate = Effect.unsafeMakeSemaphore(1);
  private settling = false;
  /** User messages of this session that an assistant message answers, per the event feed. */
  private readonly answered = new Set<string>();
  /** Feed barrier tokens awaiting their `session.updated` echo. */
  private readonly barriers = new Map<string, Deferred.Deferred<void>>();
  private readonly children = new Map<string, ChildState>();
  /** Tool parts currently executing, keyed by OpenCode call ID; used to scope child function calls. */
  private readonly runningTools = new Map<string, RunningTool>();
  private readonly toolScope = new AsyncLocalStorage<EventScope>();
  /** Fires when the feed reports the parent session idle. */
  private readonly idle = new Wake();
  /** Fires whenever a tool part changes state. */
  private readonly toolsChanged = new Wake();
  constructor(execution: Execution, options: NativeOptions) {
    super(execution, options);
    this.home = join(options.directory, "opencode");
  }
  private get subagentsEnabled(): boolean {
    return !!this.execution.agent.multi_agent?.enabled;
  }
  protected async open(bundle?: unknown): Promise<void> {
    const previous = await this.prepare(bundle);
    // Native OpenCode installs plugin dependencies into writable config directories.
    // Our plugin is already bundled: a read-only config keeps startup offline.
    const configDirectory = join(this.home, "config", "opencode");
    await mkdir(configDirectory, { recursive: true });
    await writeFile(join(configDirectory, ".gitignore"), "*\n");
    await chmod(configDirectory, 0o555);
    const reservation = createServer();
    reservation.listen(0, "127.0.0.1");
    await once(reservation, "listening");
    const address = reservation.address();
    if (!address || typeof address === "string")
      throw new NativeStartupFailed({ runtime: RUNTIME, cause: "No port available" });
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
    const sandbox = this.execution.sandbox;
    const subagents = this.subagentsEnabled;
    const format = this.execution.agent.text?.format;
    // OpenCode 1.18.30 stores the format on the user message and rejects `retryCount`
    // when reading it back, so the default retry budget applies.
    this.format =
      format?.type === "json_schema" ? { type: "json_schema", schema: format.schema } : undefined;
    const tools = {
      "*": false,
      bash: sandbox,
      read: sandbox,
      write: sandbox,
      edit: sandbox,
      "workspace_function_*": true,
      "workspace_cf_*": true,
      "workspace_remote_*": true,
      task: subagents,
      [STRUCTURED_OUTPUT]: !!this.format,
    };
    // A native `task` child inherits the deny rules of its parent session, so the
    // session-level rules carry only allows; the agent-level rules below deny the rest.
    this.promptTools = Object.fromEntries(Object.entries(tools).filter(([, allowed]) => allowed));
    const rule = (allowed: boolean): Permission => (allowed ? "allow" : "deny");
    const permission = {
      "*": "deny" as const,
      bash: rule(sandbox),
      read: rule(sandbox),
      write: rule(sandbox),
      edit: rule(sandbox),
      "workspace_function_*": "allow" as const,
      "workspace_cf_*": "allow" as const,
      "workspace_remote_*": "allow" as const,
      task: rule(subagents),
      [STRUCTURED_OUTPUT]: rule(!!this.format),
    };
    const effort = this.execution.agent.reasoning?.effort ?? null;
    this.variant =
      effort && (EFFORT_VARIANTS as readonly string[]).includes(effort) ? effort : undefined;
    const config: Config = {
      model: `gateway/${this.execution.model}`,
      small_model: `gateway/${this.execution.model}`,
      enabled_providers: ["gateway"],
      share: "disabled",
      autoupdate: false,
      snapshot: false,
      plugin: [new URL("./opencode-tools.js", import.meta.url).href],
      permission,
      tools,
      // Children may not delegate further; OpenCode also caps nesting at this depth.
      subagent_depth: 1,
      agent: {
        title: { disable: true },
        summary: { disable: true },
        build: { steps: 32 },
        ...(subagents
          ? {
              // OpenCode runs foreground tasks inline with the parent's tool calls and has
              // no concurrency knob; `max_concurrent_subagents` is best effort here.
              [SUBAGENT]: {
                description:
                  "General-purpose subagent for delegated work. Shares the parent's workspace and client tools.",
                mode: "subagent" as const,
                steps: 32,
                permission: { ...permission, task: "deny" as const },
                tools: { task: false },
              },
            }
          : {}),
      },
      mcp: {
        workspace: {
          type: "remote",
          url: `${this.options.supervisorUrl}/jobs/${this.execution.turnId}/mcp`,
          oauth: false,
          timeout: Math.max(1000, this.execution.deadline - Date.now()),
        },
      },
      provider: {
        gateway: {
          npm: "@ai-sdk/openai-compatible",
          options: {
            baseURL: this.options.modelBaseUrl,
            apiKey: "private-worker-gateway",
            timeout: 120_000,
          },
          models: {
            [this.execution.model]: {
              name: this.execution.model,
              limit: { context: 128_000, output: 8192 },
              tool_call: true,
              reasoning: true,
              modalities: { input: ["text", "image"], output: ["text"] },
              variants: Object.fromEntries(
                EFFORT_VARIANTS.map((level) => [level, { reasoningEffort: level }]),
              ),
            },
          },
        },
      },
    };
    const password = crypto.randomUUID();
    const child = spawn(
      this.options.opencodeBinary,
      ["serve", "--hostname=127.0.0.1", `--port=${address.port}`],
      {
        cwd: this.options.directory,
        env: {
          PATH: process.env.PATH,
          HOME: this.home,
          XDG_CONFIG_HOME: join(this.home, "config"),
          XDG_DATA_HOME: join(this.home, "data"),
          XDG_CACHE_HOME: join(this.home, "cache"),
          XDG_STATE_HOME: join(this.home, "state"),
          OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
          OPENCODE_SERVER_PASSWORD: password,
          OPENCODE_DISABLE_AUTOUPDATE: "true",
          OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
          OPENCODE_DISABLE_PROJECT_CONFIG: "true",
          OPENCODE_DISABLE_MODELS_FETCH: "true",
          OPENCODE_DISABLE_CLAUDE_CODE: "true",
          CF_WORKSPACE_ENDPOINT: `${this.options.supervisorUrl}/jobs/${this.execution.turnId}/workspace`,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    // The job's resources own the server process: closing them terminates it (SIGTERM, 5 s, SIGKILL).
    await this.own(child, "5 seconds");
    child.stderr?.on("data", (data) => this.options.diagnostics(String(data)));
    child.once("exit", (code, signal) => {
      if (!this.closing && !terminal(this.status))
        this.failStart(new NativeExited({ runtime: RUNTIME, code, signal }));
    });
    await this.perform(
      awaitReady(
        child,
        (tail) => tail.includes("opencode server listening"),
        STARTUP_BOUND,
        "OpenCode",
      ),
    );
    const client = createOpencodeClient({
      baseUrl: `http://127.0.0.1:${address.port}`,
      headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` },
      throwOnError: true,
    });
    this.client = client;
    const signal = this.abort.signal;
    const sessionId =
      previous ??
      (await client.session.create({ title: this.execution.sessionId }, { signal })).data?.id;
    if (!sessionId)
      throw new NativeStartupFailed({
        runtime: RUNTIME,
        cause: "OpenCode did not create a session",
      });
    this.sessionId = sessionId;
    if (previous) await client.session.get({ sessionID: previous }, { signal });
    this.run(this.turn(client));
  }
  /** The job's abort ends a request before the fiber's own interruption reaches it. */
  private signals(signal: AbortSignal): AbortSignal {
    return AbortSignal.any([this.abort.signal, signal]);
  }
  /** Every prompt of a turn shares the model, instructions, output format and variant. */
  private promptRequest(parts: PromptParts): PromptRequest {
    return {
      sessionID: this.sessionId,
      model: { providerID: "gateway", modelID: this.execution.model },
      parts,
      system: this.execution.agent.instructions ?? undefined,
      tools: this.promptTools,
      ...(this.format ? { format: this.format } : {}),
      ...(this.variant ? { variant: this.variant } : {}),
    };
  }
  /**
   * Runs the whole public turn: the initial prompt, admitted steers and their reruns.
   * The event feed is a fiber of the turn's own Scope, so it ends with the turn.
   */
  private turn(client: Client): Effect.Effect<void, unknown> {
    return Effect.scoped(
      Effect.gen(this, function* () {
        const transcript = new OpenCodeTranscript({
          sessionId: this.sessionId,
          turnId: this.execution.turnId,
          children: this.children,
          emit: (event) => this.emit(event),
          trackTool: (part) => this.trackTool(part),
          answered: (id) => this.answered.add(id),
          echoed: (token) => {
            const barrier = this.barriers.get(token);
            if (barrier) Deferred.unsafeDone(barrier, Effect.void);
          },
          idle: () => this.idle.notify(),
          diagnostics: (line) => this.options.diagnostics(line),
        });
        let streamError: unknown;
        const subscribed = yield* Deferred.make<void>();
        // Subscribing and reading share one `io`, so the fiber's signal ends the SSE
        // request whenever the turn's Scope interrupts the feed.
        const consume = async (signal: AbortSignal) => {
          const events = await client.event.subscribe({}, { signal });
          Deferred.unsafeDone(subscribed, Effect.void);
          for await (const event of events.stream as AsyncIterable<Event>) transcript.accept(event);
        };
        yield* io("opencode.events", consume).pipe(
          Effect.catchAll((error) =>
            Effect.sync(() => {
              streamError = error;
              Deferred.unsafeDone(subscribed, Effect.void);
              this.abort.abort();
            }),
          ),
          Effect.forkScoped,
        );
        yield* Deferred.await(subscribed);
        // The public code is applied where the condition is seen; the tag carries it for diagnostics.
        const failed = (code: string, reason: string) =>
          new NativeTurnFailed({ runtime: RUNTIME, code, reason });
        if (streamError)
          return yield* failed("native_harness_failed", describeFailure(streamError));
        const prompt = (input: PromptParts) =>
          Effect.gen(this, function* () {
            const result = yield* io("opencode.prompt", (signal) =>
              client.session.prompt(this.promptRequest(input), { signal: this.signals(signal) }),
            );
            if (streamError)
              return yield* failed("native_harness_failed", describeFailure(streamError));
            const info = result.data?.info;
            if (!result.data || !info)
              return yield* failed(
                "native_harness_failed",
                "OpenCode returned no assistant message",
              );
            if (info.error) {
              if (info.error.name === "MessageAbortedError")
                return yield* failed("native_harness_failed", "OpenCode turn aborted");
              const mapped = opencodeTurnError(info.error);
              this.options.diagnostics(`opencode ${info.error.name}: ${mapped.detail}`);
              this.lifecycle.fail(mapped.code);
              return yield* failed(mapped.code, `OpenCode turn failed: ${info.error.name}`);
            }
            const finish = info.finish ?? "stop";
            // A structured answer is delivered through the StructuredOutput tool call.
            const structured = info.structured !== undefined && finish === "tool-calls";
            if (!structured && !["stop", "end_turn", "unknown"].includes(finish)) {
              this.options.diagnostics(`opencode finish=${finish}`);
              this.lifecycle.fail("internal_error");
              return yield* failed("internal_error", `OpenCode turn finished with ${finish}`);
            }
            return result.data;
          });
        let last = yield* prompt(
          yield* io("opencode.input", () => this.inputParts(this.execution.input)),
        );
        for (;;) {
          // A steer admitted while the loop ran was answered before the prompt resolved;
          // one admitted while the session was idle started a loop of its own.
          yield* this.untilIdle(client);
          const orphans = yield* this.settle(client);
          if (!orphans.length) break;
          // The loop had exited before these steers were stored: rerun them in this turn.
          for (const id of orphans)
            yield* io("opencode.deleteMessage", (signal) =>
              client.session.deleteMessage(
                { sessionID: this.sessionId, messageID: id },
                { signal: this.signals(signal) },
              ),
            );
          last = yield* prompt(orphans.flatMap((id) => this.steered.get(id) ?? []));
          for (const id of orphans) this.steered.delete(id);
        }
        // The event feed can lag behind the prompt response; once it has caught up
        // the final usage report covers every inference of this turn.
        yield* this.barrier(client);
        transcript.record(last.info);
        transcript.publishUsage();
        transcript.closeChildren();
        transcript.flushAll();
        const finalText = last.parts.filter(
          (part): part is Extract<Part, { type: "text" }> => part.type === "text",
        );
        if (last.info.structured !== undefined) {
          // The public answer is the validated structured value, like Codex's outputSchema.
          const id = finalText.at(-1)?.id ?? `structured:${last.info.id}`;
          for (const part of finalText) transcript.claim(part.id);
          this.emit({
            type: "text",
            id,
            text: JSON.stringify(last.info.structured),
            phase: "final_answer",
          });
        } else
          for (const part of finalText)
            if (transcript.claim(part.id))
              this.emit({ type: "text", id: part.id, text: part.text, phase: "final_answer" });
      }),
    );
  }
  /**
   * Waits until OpenCode reports the session idle, bounded by the execution deadline.
   * A probe that fails says nothing about the loop, so it reads as busy and is
   * retried after the wait: reading it as idle could rerun a steer the loop is
   * still answering.
   */
  protected untilIdle(client: StatusClient): Effect.Effect<void> {
    return Effect.gen(this, function* () {
      let reported = false;
      for (;;) {
        // Captured before the status read: an idle event that lands during it still wakes the wait.
        const woken = this.idle.wait();
        const status = yield* io("opencode.status", (signal) =>
          client.session.status({}, { signal: this.signals(signal) }),
        ).pipe(
          Effect.map((response) => Option.some(response.data)),
          Effect.catchAll((error) =>
            Effect.sync(() => {
              if (!reported) this.options.diagnostics(`opencode status: ${describeFailure(error)}`);
              reported = true;
              return Option.none();
            }),
          ),
        );
        const busy = Option.match(status, {
          onNone: () => true,
          onSome: (data) =>
            data && typeof data === "object" && this.sessionId in data
              ? (data as Record<string, { type?: string }>)[this.sessionId]?.type !== "idle"
              : false,
        });
        if (!busy || this.closing) return;
        yield* within(woken, "250 millis");
        if (Date.now() > this.execution.deadline) return;
      }
    });
  }
  /** Runs `task` after every earlier gated task, whatever their outcome. */
  private locked<A, E>(task: Effect.Effect<A, E>): Effect.Effect<A, E> {
    return this.gate.withPermits(1)(task);
  }
  /**
   * Resolves once the event feed has delivered everything published before the
   * call: a session metadata write echoes back as `session.updated` in feed order.
   * (Listing messages instead would trip OpenCode 1.18.30's re-encoding of a stored
   * json_schema format, which fails every structured turn.)
   */
  private barrier(client: Client): Effect.Effect<void, unknown> {
    return Effect.gen(this, function* () {
      const token = crypto.randomUUID();
      const echoed = yield* Deferred.make<void>();
      this.barriers.set(token, echoed);
      yield* Effect.gen(this, function* () {
        yield* io("opencode.update", (signal) =>
          client.session.update(
            { sessionID: this.sessionId, metadata: { cf_sync: token } },
            { signal: this.signals(signal) },
          ),
        );
        if (!(yield* within(Deferred.await(echoed), BARRIER_BOUND)))
          this.options.diagnostics("opencode event feed barrier timed out");
      }).pipe(Effect.ensuring(Effect.sync(() => this.barriers.delete(token))));
    });
  }
  /**
   * Under the steer gate: returns the steers OpenCode's loop never answered. With
   * none, the turn settles and later steers are rejected for the next turn.
   */
  private settle(client: Client): Effect.Effect<string[], unknown> {
    return this.locked(
      Effect.gen(this, function* () {
        if (this.steered.size) yield* this.barrier(client);
        const orphans = [...this.steered.keys()].filter((id) => !this.answered.has(id));
        for (const id of this.steered.keys()) if (this.answered.has(id)) this.steered.delete(id);
        this.settling = orphans.length === 0;
        return orphans;
      }),
    );
  }
  private async inputParts(input: InputMessage[]): Promise<PromptParts> {
    return Promise.all(
      input
        .flatMap((message) => message.content)
        .map(async (part) => {
          if (part.type === "input_text") return { type: "text" as const, text: part.text };
          const image = await imageContent(
            part.image_url,
            this.abort.signal,
            this.options.mediaUrl,
          );
          return {
            type: "file" as const,
            mime: image.mimeType,
            url: `data:${image.mimeType};base64,${image.data}`,
          };
        }),
    );
  }
  /**
   * Steering: a `noReply` prompt stores the user message in the busy session without
   * starting another loop. OpenCode's loop re-reads the session before each
   * inference and answers the newest user message, so the steered input reaches
   * the model right after the step in flight. If the loop had already exited,
   * `settle` finds the message unanswered and reruns it before this turn completes.
   */
  protected override steer(input: InputMessage[]) {
    return Effect.gen(this, function* () {
      const client = this.client;
      if (!client || !this.sessionId)
        return yield* new CommandRejected({ reason: "OpenCode session is not running" });
      const parts = yield* io("opencode.input", () => this.inputParts(input));
      yield* this.locked(
        Effect.gen(this, function* () {
          if (this.settling || this.closing)
            return yield* new CommandRejected({ reason: "OpenCode turn has already settled" });
          const stored = yield* io("opencode.steer", (signal) =>
            client.session.prompt(
              { ...this.promptRequest(parts), noReply: true },
              { signal: this.signals(signal) },
            ),
          );
          // With `noReply` the created user message is returned instead of an assistant one.
          // A stored message we cannot see is an unknown outcome: transient, so the Worker retries.
          const info = stored.data?.info as Message | undefined;
          if (info?.role !== "user")
            return yield* new OperationError({
              operation: "opencode.steer",
              cause: "OpenCode did not store the steered message",
            });
          this.steered.set(info.id, parts);
        }),
      );
    });
  }
  private trackTool(part: ToolPart): void {
    const state = part.state;
    if (state.status === "pending" || state.status === "running")
      this.runningTools.set(part.callID, {
        sessionId: part.sessionID,
        tool: part.tool,
        input: JSON.stringify(state.input ?? {}),
      });
    else this.runningTools.delete(part.callID);
    this.toolsChanged.notify();
  }
  /**
   * Function calls raised by a child session are scoped to that child's public
   * turn. The feed may deliver the running tool part slightly after the call
   * itself, so the match waits, bounded, for the next tool-part update.
   */
  private scopeFor(name: string, args: unknown): Effect.Effect<EventScope | undefined> {
    const unscoped: EventScope | undefined = undefined;
    if (!this.children.size) return Effect.succeed(unscoped);
    const wanted = JSON.stringify(args ?? {});
    const tool = `${WORKSPACE_PREFIX}${name}`;
    const lookup = (): Option.Option<EventScope | undefined> => {
      for (const running of this.runningTools.values())
        if (running.tool === tool && running.input === wanted) {
          if (running.sessionId === this.sessionId) return Option.some(unscoped);
          const child = this.children.get(running.sessionId);
          if (child) return Option.some({ subagentId: child.subagentId, turnId: child.turnId });
        }
      return Option.none();
    };
    return Effect.gen(this, function* () {
      for (;;) {
        const woken = this.toolsChanged.wait();
        const found = lookup();
        if (Option.isSome(found)) return found.value;
        yield* within(woken, "25 millis");
      }
    }).pipe(Effect.timeoutOption("1 second"), Effect.map(Option.getOrUndefined));
  }
  protected override async callTool(name: string, args: unknown) {
    const scope = await this.perform(this.scopeFor(name, args));
    return scope
      ? this.toolScope.run(scope, () => super.callTool(name, args))
      : super.callTool(name, args);
  }
  protected override emit(event: RuntimeEvent): void {
    const scope = this.toolScope.getStore();
    super.emit(scope && event.type === "function_call" ? { ...event, ...scope } : event);
  }
  /** The server process itself is terminated by the resource Scope that owns it. */
  protected closeRuntime() {
    return io("opencode.unlock", () => chmod(join(this.home, "config", "opencode"), 0o755)).pipe(
      Effect.ignore,
    );
  }
}
