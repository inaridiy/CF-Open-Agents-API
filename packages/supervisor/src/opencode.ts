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
  Session,
  ToolPart,
} from "@opencode-ai/sdk/v2/types";
import {
  ApiError,
  type Execution,
  type InputMessage,
  io,
  type RuntimeEvent,
} from "cf-open-agents-api";
import { Data, Deferred, Effect, Option } from "effect";

import { type NativeOptions, ToolJob } from "./job.js";
import { describeFailure, type TurnErrorCode, Wake, within } from "./lifecycle.js";
import { imageContent } from "./media.js";
import { awaitReady } from "./process.js";

type Client = ReturnType<typeof createOpencodeClient>;
type PromptRequest = Parameters<Client["session"]["prompt"]>[0];
type PromptParts = NonNullable<PromptRequest["parts"]>;
type OutputFormat = NonNullable<PromptRequest["format"]>;
type Permission = "allow" | "deny";
type EventScope = { subagentId: string; turnId: string };

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

/** The native turn cannot continue; the message names the OpenCode condition. */
class OpenCodeTurnFailed extends Data.TaggedError("OpenCodeTurnFailed")<{
  readonly message: string;
}> {}

interface ChildState {
  readonly sessionId: string;
  readonly subagentId: string;
  readonly turnId: string;
  readonly openedAt: number;
  name: string | null;
  closed: boolean;
}
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
      const status = typeof data.statusCode === "number" ? data.statusCode : undefined;
      const code: TurnErrorCode =
        status === undefined
          ? "connection_failed"
          : status === 429
            ? "rate_limit_exceeded"
            : status === 401 || status === 403
              ? "authentication_error"
              : status === 404
                ? "resource_not_found"
                : status === 408
                  ? "request_timeout"
                  : status === 503 || status === 529
                    ? "server_overloaded"
                    : status >= 500
                      ? "server_error"
                      : status >= 400
                        ? "invalid_request"
                        : "server_error";
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
    if (!address || typeof address === "string") throw new Error("No OpenCode port available");
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
    child.once("exit", () => {
      if (!this.closing && !["completed", "cancelled", "failed"].includes(this.status))
        this.failStart(new Error("OpenCode exited"));
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
    if (!sessionId) throw new Error("OpenCode did not create a session");
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
        const usage = new Map<string, AssistantMessage>();
        const started = Date.now();
        const record = (info: AssistantMessage) => {
          if (info.sessionID !== this.sessionId || info.time.created < started) return false;
          usage.set(info.id, info);
          return true;
        };
        const publishUsage = (messages: Iterable<AssistantMessage>, scope?: EventScope) => {
          const list = [...messages];
          const input = list.reduce(
            (sum, message) =>
              sum + message.tokens.input + message.tokens.cache.read + message.tokens.cache.write,
            0,
          );
          const output = list.reduce(
            (sum, message) => sum + message.tokens.output + message.tokens.reasoning,
            0,
          );
          this.emit({
            type: "usage",
            id: `usage:${scope?.turnId ?? this.execution.turnId}`,
            usage: {
              input_tokens: input,
              output_tokens: output,
              total_tokens: input + output,
              input_tokens_details: {
                cached_tokens: list.reduce((sum, message) => sum + message.tokens.cache.read, 0),
              },
              output_tokens_details: {
                reasoning_tokens: list.reduce((sum, message) => sum + message.tokens.reasoning, 0),
              },
            },
            ...scope,
          });
        };
        const childUsage = new Map<string, Map<string, AssistantMessage>>();
        const parts = new Map<string, Part["type"]>();
        /** Completed text parts wait for their step to finish so their phase is known. */
        const pendingText = new Map<string, { id: string; text: string; scope?: EventScope }[]>();
        const emittedText = new Set<string>();
        const flushText = (messageId: string, phase: "commentary" | "final_answer") => {
          for (const entry of pendingText.get(messageId) ?? []) {
            if (emittedText.has(entry.id)) continue;
            emittedText.add(entry.id);
            this.emit({ type: "text", id: entry.id, text: entry.text, phase, ...entry.scope });
          }
          pendingText.delete(messageId);
        };
        const phaseOf = (finish: string) =>
          finish.includes("tool") ? "commentary" : "final_answer";
        const scopeOf = (sessionId: string): EventScope | undefined => {
          if (sessionId === this.sessionId) return undefined;
          const child = this.children.get(sessionId);
          return child ? { subagentId: child.subagentId, turnId: child.turnId } : undefined;
        };
        const openChild = (info: Session) => {
          if (!info.parentID || info.parentID !== this.sessionId) return;
          const existing = this.children.get(info.id);
          if (existing) {
            if (info.title && existing.name !== info.title) existing.name = info.title;
            return;
          }
          const suffix = info.id.replace(/[^a-zA-Z0-9]/g, "");
          const child: ChildState = {
            sessionId: info.id,
            subagentId: `subagent_${suffix}`,
            turnId: `turn_${suffix}`,
            openedAt: Math.floor((info.time?.created ?? Date.now()) / 1000),
            name: info.title || null,
            closed: false,
          };
          this.children.set(info.id, child);
          this.emit({
            type: "subagent",
            id: child.subagentId,
            parentId: null,
            name: child.name,
            instructions: null,
            openedAt: child.openedAt,
            status: "active",
          });
          this.emit({
            type: "subagent_turn",
            id: child.turnId,
            subagentId: child.subagentId,
            status: "in_progress",
            startedAt: child.openedAt,
            completedAt: null,
          });
        };
        const closeChild = (child: ChildState, status: "completed" | "failed") => {
          if (child.closed) return;
          child.closed = true;
          for (const messageId of Array.from(pendingText.keys()))
            if (pendingText.get(messageId)?.some((entry) => entry.scope?.turnId === child.turnId))
              flushText(messageId, "final_answer");
          this.emit({
            type: "subagent_turn",
            id: child.turnId,
            subagentId: child.subagentId,
            status,
            startedAt: child.openedAt,
            completedAt: Math.floor(Date.now() / 1000),
          });
          this.emit({
            type: "subagent",
            id: child.subagentId,
            parentId: null,
            name: child.name,
            instructions: null,
            openedAt: child.openedAt,
            status: "closed",
          });
        };
        const collectPart = (part: Part) => {
          const scope = scopeOf(part.sessionID);
          if (part.sessionID !== this.sessionId && !scope) return;
          parts.set(part.id, part.type);
          if (part.type === "tool") this.trackTool(part);
          if (part.type === "reasoning")
            this.emit({
              type: "reasoning",
              id: part.id,
              summary: [part.text],
              status: part.time.end ? "completed" : "in_progress",
              ...scope,
            });
          if (part.type === "text" && part.time?.end && !emittedText.has(part.id)) {
            const pending = pendingText.get(part.messageID) ?? [];
            if (!pending.some((entry) => entry.id === part.id))
              pending.push({ id: part.id, text: part.text, ...(scope ? { scope } : {}) });
            pendingText.set(part.messageID, pending);
          }
          // A step that ends with tool calls makes its text commentary; a final step answers.
          if (part.type === "step-finish") flushText(part.messageID, phaseOf(part.reason));
        };
        let streamError: unknown;
        const subscribed = yield* Deferred.make<void>();
        // Subscribing and reading share one `io`, so the fiber's signal ends the SSE
        // request whenever the turn's Scope interrupts the feed.
        const consume = async (signal: AbortSignal) => {
          const events = await client.event.subscribe({}, { signal });
          Deferred.unsafeDone(subscribed, Effect.void);
          for await (const event of events.stream as AsyncIterable<Event>) {
            if (process.env.CF_OPENCODE_TRACE)
              this.options.diagnostics(`opencode-event ${trace(event)}`);
            if (event.type === "session.created" || event.type === "session.updated")
              openChild(event.properties.info);
            if (event.type === "session.updated" && event.properties.info.id === this.sessionId) {
              const token = event.properties.info.metadata?.cf_sync;
              const barrier = typeof token === "string" ? this.barriers.get(token) : undefined;
              if (barrier) Deferred.unsafeDone(barrier, Effect.void);
            }
            if (event.type === "message.updated" && event.properties.info.role === "assistant") {
              const info = event.properties.info;
              const scope = scopeOf(info.sessionID);
              if (info.sessionID === this.sessionId) {
                this.answered.add(info.parentID);
                if (record(info)) publishUsage(usage.values());
              } else if (scope) {
                const list = childUsage.get(info.sessionID) ?? new Map<string, AssistantMessage>();
                list.set(info.id, info);
                childUsage.set(info.sessionID, list);
                publishUsage(list.values(), scope);
              }
              if (
                (info.sessionID === this.sessionId || scope) &&
                info.finish &&
                pendingText.has(info.id)
              )
                flushText(info.id, phaseOf(info.finish));
            }
            if (event.type === "message.part.updated") collectPart(event.properties.part);
            if (event.type === "message.part.delta" && event.properties.field === "text") {
              const scope = scopeOf(event.properties.sessionID);
              if (event.properties.sessionID === this.sessionId || scope)
                this.emit(
                  parts.get(event.properties.partID) === "reasoning"
                    ? {
                        type: "reasoning_delta",
                        id: event.properties.partID,
                        summaryIndex: 0,
                        text: event.properties.delta,
                        ...scope,
                      }
                    : {
                        type: "delta",
                        id: event.properties.partID,
                        text: event.properties.delta,
                        ...scope,
                      },
                );
            }
            if (event.type === "session.status" && event.properties.status.type === "retry") {
              const { attempt, message, next } = event.properties.status;
              this.options.diagnostics(
                `opencode retry session=${event.properties.sessionID} attempt=${attempt} next_in_ms=${Math.max(0, next - Date.now())}: ${message}`,
              );
            }
            if (event.type === "session.idle") {
              const child = this.children.get(event.properties.sessionID);
              if (child) closeChild(child, "completed");
              if (event.properties.sessionID === this.sessionId) this.idle.notify();
            }
            if (event.type === "session.error") {
              const child = this.children.get(event.properties.sessionID ?? "");
              if (child) closeChild(child, "failed");
              if (event.properties.error)
                this.options.diagnostics(
                  `opencode session.error session=${event.properties.sessionID ?? "none"}: ${event.properties.error.name}`,
                );
            }
          }
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
        const failed = (message: string) => new OpenCodeTurnFailed({ message });
        if (streamError) return yield* failed(describeFailure(streamError));
        const prompt = (input: PromptParts) =>
          Effect.gen(this, function* () {
            const result = yield* io("opencode.prompt", (signal) =>
              client.session.prompt(this.promptRequest(input), { signal: this.signals(signal) }),
            );
            if (streamError) return yield* failed(describeFailure(streamError));
            const info = result.data?.info;
            if (!result.data || !info)
              return yield* failed("OpenCode returned no assistant message");
            if (info.error) {
              if (info.error.name === "MessageAbortedError")
                return yield* failed("OpenCode turn aborted");
              const mapped = opencodeTurnError(info.error);
              this.options.diagnostics(`opencode ${info.error.name}: ${mapped.detail}`);
              this.lifecycle.fail(mapped.code);
              return yield* failed(`OpenCode turn failed: ${info.error.name}`);
            }
            const finish = info.finish ?? "stop";
            // A structured answer is delivered through the StructuredOutput tool call.
            const structured = info.structured !== undefined && finish === "tool-calls";
            if (!structured && !["stop", "end_turn", "unknown"].includes(finish)) {
              this.options.diagnostics(`opencode finish=${finish}`);
              this.lifecycle.fail("internal_error");
              return yield* failed(`OpenCode turn finished with ${finish}`);
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
        record(last.info);
        publishUsage(usage.values());
        for (const child of this.children.values()) closeChild(child, "completed");
        for (const messageId of Array.from(pendingText.keys()))
          flushText(messageId, "final_answer");
        const finalText = last.parts.filter(
          (part): part is Extract<Part, { type: "text" }> => part.type === "text",
        );
        if (last.info.structured !== undefined) {
          // The public answer is the validated structured value, like Codex's outputSchema.
          const id = finalText.at(-1)?.id ?? `structured:${last.info.id}`;
          for (const part of finalText) emittedText.add(part.id);
          this.emit({
            type: "text",
            id,
            text: JSON.stringify(last.info.structured),
            phase: "final_answer",
          });
        } else
          for (const part of finalText)
            if (!emittedText.has(part.id)) {
              emittedText.add(part.id);
              this.emit({ type: "text", id: part.id, text: part.text, phase: "final_answer" });
            }
      }),
    );
  }
  /** Waits until OpenCode reports the session idle, bounded by the execution deadline. */
  private untilIdle(client: Client): Effect.Effect<void> {
    return Effect.gen(this, function* () {
      for (;;) {
        // Captured before the status read: an idle event that lands during it still wakes the wait.
        const woken = this.idle.wait();
        const status = yield* io("opencode.status", (signal) =>
          client.session.status({}, { signal: this.signals(signal) }),
        ).pipe(
          Effect.map((response) => response.data),
          Effect.orElseSucceed(() => undefined),
        );
        const busy =
          status && typeof status === "object" && this.sessionId in status
            ? (status as Record<string, { type?: string }>)[this.sessionId]?.type !== "idle"
            : false;
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
        return yield* new ApiError(409, "command_rejected", "OpenCode session is not running");
      const parts = yield* io("opencode.input", () => this.inputParts(input));
      yield* this.locked(
        Effect.gen(this, function* () {
          if (this.settling || this.closing)
            return yield* new ApiError(
              409,
              "command_rejected",
              "OpenCode turn has already settled",
            );
          const stored = yield* io("opencode.steer", (signal) =>
            client.session.prompt(
              { ...this.promptRequest(parts), noReply: true },
              { signal: this.signals(signal) },
            ),
          );
          // With `noReply` the created user message is returned instead of an assistant one.
          const info = stored.data?.info as Message | undefined;
          if (info?.role !== "user")
            return yield* new OpenCodeTurnFailed({
              message: "OpenCode did not store the steered message",
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
    if (!this.children.size) return Effect.succeed(undefined);
    const wanted = JSON.stringify(args ?? {});
    const tool = `${WORKSPACE_PREFIX}${name}`;
    const lookup = (): Option.Option<EventScope | undefined> => {
      for (const running of this.runningTools.values())
        if (running.tool === tool && running.input === wanted) {
          if (running.sessionId === this.sessionId) return Option.some(undefined);
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

function trace(event: Event): string {
  const properties = (event as { properties?: Record<string, unknown> }).properties ?? {};
  const summary: Record<string, unknown> = { type: event.type };
  if ("sessionID" in properties) summary.sessionID = properties.sessionID;
  if ("part" in properties) {
    const part = properties.part as Part;
    summary.part = {
      type: part.type,
      id: part.id,
      messageID: part.messageID,
      ...(part.type === "tool"
        ? {
            tool: part.tool,
            callID: part.callID,
            status: part.state.status,
            ...(part.state.status === "error" ? { error: part.state.error.slice(0, 300) } : {}),
          }
        : {}),
      ...(part.type === "step-finish" ? { reason: part.reason } : {}),
      ...(part.type === "text" ? { end: !!part.time?.end } : {}),
    };
  }
  if ("info" in properties) {
    const info = properties.info as Record<string, unknown>;
    summary.info = {
      id: info.id,
      role: info.role,
      finish: info.finish,
      parentID: info.parentID,
      error: (info.error as { name?: string } | undefined)?.name,
      structured: info.structured !== undefined,
    };
  }
  if ("status" in properties) summary.status = properties.status;
  return JSON.stringify(summary);
}
