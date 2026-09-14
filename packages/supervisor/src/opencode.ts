import { AsyncLocalStorage } from "node:async_hooks";
import { type ChildProcess, spawn } from "node:child_process";
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
import { ApiError, type Execution, type InputMessage, type RuntimeEvent } from "cf-open-agents-api";

import { type NativeOptions, ToolJob } from "./job.js";
import { describeFailure, type TurnErrorCode } from "./lifecycle.js";
import { imageContent } from "./media.js";

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
  private child?: ChildProcess;
  private client?: Client;
  private format?: OutputFormat;
  private variant?: string;
  /** Session-level tool rules: allows only, so task children inherit no wildcard deny. */
  private promptTools: Record<string, boolean> = {};
  /** Steered user messages stored in the session, keyed by their OpenCode message ID. */
  private readonly steered = new Map<string, PromptParts>();
  /** Serializes steer admission against the turn's settlement check. */
  private gate: Promise<unknown> = Promise.resolve();
  private settling = false;
  /** User messages of this session that an assistant message answers, per the event feed. */
  private readonly answered = new Set<string>();
  /** Feed barrier tokens awaiting their `session.updated` echo. */
  private readonly barriers = new Map<string, () => void>();
  private readonly children = new Map<string, ChildState>();
  /** Tool parts currently executing, keyed by OpenCode call ID; used to scope child function calls. */
  private readonly runningTools = new Map<string, RunningTool>();
  private readonly toolScope = new AsyncLocalStorage<EventScope>();
  private idle?: () => void;
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
    this.child = child;
    child.stderr?.on("data", (data) => this.options.diagnostics(String(data)));
    child.once("exit", () => {
      if (!this.closing && !["completed", "cancelled", "failed"].includes(this.status))
        this.failStart(new Error("OpenCode exited"));
    });
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("OpenCode startup timed out")), 30_000);
      let output = "";
      child.stdout?.on("data", (data) => {
        output = (output + String(data)).slice(-4096);
        if (output.includes("opencode server listening")) {
          clearTimeout(timeout);
          resolve();
        }
      });
      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once("exit", () => {
        clearTimeout(timeout);
        reject(new Error("OpenCode exited during startup"));
      });
    });
    const client = createOpencodeClient({
      baseUrl: `http://127.0.0.1:${address.port}`,
      headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` },
      throwOnError: true,
    });
    this.client = client;
    const sessionId =
      previous ?? (await client.session.create({ title: this.execution.sessionId })).data?.id;
    if (!sessionId) throw new Error("OpenCode did not create a session");
    this.sessionId = sessionId;
    if (previous) await client.session.get({ sessionID: previous });
    this.run(() => this.turn(client));
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
  /** Runs the whole public turn: the initial prompt, admitted steers and their reruns. */
  private async turn(client: Client): Promise<void> {
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
    const phaseOf = (finish: string) => (finish.includes("tool") ? "commentary" : "final_answer");
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
    const updates = new AbortController();
    const events = await client.event.subscribe({}, { signal: updates.signal });
    let streamError: unknown;
    const consume = (async () => {
      for await (const event of events.stream as AsyncIterable<Event>) {
        if (process.env.CF_OPENCODE_TRACE)
          this.options.diagnostics(`opencode-event ${trace(event)}`);
        if (event.type === "session.created" || event.type === "session.updated")
          openChild(event.properties.info);
        if (event.type === "session.updated" && event.properties.info.id === this.sessionId) {
          const token = event.properties.info.metadata?.cf_sync;
          if (typeof token === "string") this.barriers.get(token)?.();
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
          if (event.properties.sessionID === this.sessionId) this.idle?.();
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
    })().catch((error) => {
      if (!updates.signal.aborted) {
        streamError = error;
        this.abort.abort();
      }
    });
    const prompt = async (input: PromptParts) => {
      const result = await client.session.prompt(this.promptRequest(input), {
        signal: this.abort.signal,
      });
      if (streamError)
        throw streamError instanceof Error ? streamError : new Error(describeFailure(streamError));
      const info = result.data?.info;
      if (!result.data || !info) throw new Error("OpenCode returned no assistant message");
      if (info.error) {
        if (info.error.name === "MessageAbortedError") throw new Error("OpenCode turn aborted");
        const mapped = opencodeTurnError(info.error);
        this.options.diagnostics(`opencode ${info.error.name}: ${mapped.detail}`);
        this.lifecycle.fail(mapped.code);
        throw new Error(`OpenCode turn failed: ${info.error.name}`);
      }
      const finish = info.finish ?? "stop";
      // A structured answer is delivered through the StructuredOutput tool call.
      const structured = info.structured !== undefined && finish === "tool-calls";
      if (!structured && !["stop", "end_turn", "unknown"].includes(finish)) {
        this.options.diagnostics(`opencode finish=${finish}`);
        this.lifecycle.fail("internal_error");
        throw new Error(`OpenCode turn finished with ${finish}`);
      }
      return result.data;
    };
    try {
      let last = await prompt(await this.inputParts(this.execution.input));
      for (;;) {
        // A steer admitted while the loop ran was answered before the prompt resolved;
        // one admitted while the session was idle started a loop of its own.
        await this.untilIdle(client);
        const orphans = await this.settle(client);
        if (!orphans.length) break;
        // The loop had exited before these steers were stored: rerun them in this turn.
        for (const id of orphans)
          await client.session.deleteMessage(
            { sessionID: this.sessionId, messageID: id },
            { signal: this.abort.signal },
          );
        last = await prompt(orphans.flatMap((id) => this.steered.get(id) ?? []));
        for (const id of orphans) this.steered.delete(id);
      }
      // The event feed can lag behind the prompt response; once it has caught up
      // the final usage report covers every inference of this turn.
      await this.barrier(client);
      record(last.info);
      publishUsage(usage.values());
      for (const child of this.children.values()) closeChild(child, "completed");
      for (const messageId of Array.from(pendingText.keys())) flushText(messageId, "final_answer");
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
    } finally {
      updates.abort();
      await consume;
    }
  }
  /** Waits until OpenCode reports the session idle, bounded by the execution deadline. */
  private async untilIdle(client: Client): Promise<void> {
    for (;;) {
      const status = await client.session
        .status()
        .then((response) => response.data)
        .catch(() => undefined);
      const busy =
        status && typeof status === "object" && this.sessionId in status
          ? (status as Record<string, { type?: string }>)[this.sessionId]?.type !== "idle"
          : false;
      if (!busy || this.closing) return;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 250);
        this.idle = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.idle = undefined;
      if (Date.now() > this.execution.deadline) return;
    }
  }
  /** Runs `task` after every earlier gated task, whatever their outcome. */
  private locked<T>(task: () => Promise<T>): Promise<T> {
    const run = this.gate.then(task, task);
    this.gate = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
  /**
   * Resolves once the event feed has delivered everything published before the
   * call: a session metadata write echoes back as `session.updated` in feed order.
   * (Listing messages instead would trip OpenCode 1.18.30's re-encoding of a stored
   * json_schema format, which fails every structured turn.)
   */
  private async barrier(client: Client): Promise<void> {
    const token = crypto.randomUUID();
    let timer: NodeJS.Timeout | undefined;
    const echoed = new Promise<void>((resolve) => {
      this.barriers.set(token, resolve);
      timer = setTimeout(() => {
        this.options.diagnostics("opencode event feed barrier timed out");
        resolve();
      }, 10_000);
    });
    try {
      await client.session.update(
        { sessionID: this.sessionId, metadata: { cf_sync: token } },
        { signal: this.abort.signal },
      );
      await echoed;
    } finally {
      clearTimeout(timer);
      this.barriers.delete(token);
    }
  }
  /**
   * Under the steer gate: returns the steers OpenCode's loop never answered. With
   * none, the turn settles and later steers are rejected for the next turn.
   */
  private settle(client: Client): Promise<string[]> {
    return this.locked(async () => {
      if (this.steered.size) await this.barrier(client);
      const orphans = [...this.steered.keys()].filter((id) => !this.answered.has(id));
      for (const id of this.steered.keys()) if (this.answered.has(id)) this.steered.delete(id);
      this.settling = orphans.length === 0;
      return orphans;
    });
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
  protected override async steer(input: InputMessage[]): Promise<void> {
    const client = this.client;
    if (!client || !this.sessionId)
      throw new ApiError(409, "command_rejected", "OpenCode session is not running");
    const parts = await this.inputParts(input);
    await this.locked(async () => {
      if (this.settling || this.closing)
        throw new ApiError(409, "command_rejected", "OpenCode turn has already settled");
      const stored = await client.session.prompt(
        { ...this.promptRequest(parts), noReply: true },
        { signal: this.abort.signal },
      );
      // With `noReply` the created user message is returned instead of an assistant one.
      const info = stored.data?.info as Message | undefined;
      if (info?.role !== "user") throw new Error("OpenCode did not store the steered message");
      this.steered.set(info.id, parts);
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
  }
  /** Function calls raised by a child session are scoped to that child's public turn. */
  private async scopeFor(name: string, args: unknown): Promise<EventScope | undefined> {
    if (!this.children.size) return undefined;
    const wanted = JSON.stringify(args ?? {});
    const deadline = Date.now() + 1_000;
    for (;;) {
      for (const running of this.runningTools.values())
        if (running.tool === `${WORKSPACE_PREFIX}${name}` && running.input === wanted) {
          if (running.sessionId === this.sessionId) return undefined;
          const child = this.children.get(running.sessionId);
          if (child) return { subagentId: child.subagentId, turnId: child.turnId };
        }
      if (Date.now() >= deadline) return undefined;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  protected override async callTool(name: string, args: unknown) {
    const scope = await this.scopeFor(name, args);
    return scope
      ? this.toolScope.run(scope, () => super.callTool(name, args))
      : super.callTool(name, args);
  }
  protected override emit(event: RuntimeEvent): void {
    const scope = this.toolScope.getStore();
    super.emit(scope && event.type === "function_call" ? { ...event, ...scope } : event);
  }
  protected async closeRuntime(): Promise<void> {
    await chmod(join(this.home, "config", "opencode"), 0o755).catch(() => {});
    if (!this.child || this.child.exitCode !== null || this.child.signalCode !== null) return;
    const exited = once(this.child, "exit");
    this.child.kill("SIGTERM");
    const force = setTimeout(() => this.child?.kill("SIGKILL"), 5000);
    try {
      await exited;
    } finally {
      clearTimeout(force);
    }
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
