import { setTimeout as delay } from "node:timers/promises";

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  ApiError,
  batchSchema,
  decode,
  type Execution,
  type JsonValue,
  type RuntimeCommand,
  type RuntimeEvent,
} from "cf-open-agents-api";
import { z } from "zod";

type ChildStatus = "in_progress" | "completed" | "cancelled" | "failed";
interface Child {
  readonly subagentId: string;
  readonly turnId: string;
  readonly alias: string;
  readonly name: string | null;
  readonly prompt: string;
  readonly openedAt: number;
  cursor: number;
  status: ChildStatus;
  error: string | null;
  output: string;
  closed: boolean;
  /** Client function calls raised by the child; their results are routed back to it. */
  readonly pending: Set<string>;
  readonly settled: Promise<void>;
  finish: () => void;
}
export interface DelegationOptions {
  /** Private HarnessDO route that starts, polls and controls delegated children. */
  endpoint: string;
  signal: AbortSignal;
  emit: (event: RuntimeEvent) => void;
  /** A child whose side effects became uncertain ends the whole turn. */
  fail: (error: string) => void;
  /** Invoked whenever a child reaches a terminal status. */
  settled?: () => void;
  diagnostics: (line: string) => void;
  pollIntervalMs?: number;
  /** Bounds for HarnessDO round trips; a stalled route must not hold the parent's lifecycle. */
  timeouts?: { requestMs?: number; cancelMs?: number; settleMs?: number };
}
const DEFAULT_TIMEOUTS = { requestMs: 30_000, cancelMs: 10_000, settleMs: 5_000 };
/** A HarnessDO delegate route answered with an error status. */
export class DelegateRouteError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`Delegation request failed (${status}): ${body}`);
  }
}
/** Resolve when `promise` settles or after `ms`; the timer never outlives the race. */
async function within(promise: Promise<unknown>, ms: number): Promise<boolean> {
  const timer = new AbortController();
  return Promise.race([
    promise.then(
      () => true,
      () => true,
    ),
    delay(ms, false, { signal: timer.signal }).catch(() => false),
  ]).finally(() => timer.abort());
}
const spawnSchema = z.strictObject({
  model: z.string().min(1),
  prompt: z.string().min(1).max(128_000),
  name: z.string().max(256).optional(),
});
const waitSchema = z.strictObject({
  subagent_ids: z.array(z.string()).max(64).optional(),
  timeout_ms: z.number().int().positive().optional(),
});
const closeSchema = z.strictObject({ subagent_id: z.string() });
export const DELEGATION_TOOLS = new Set(["cf_delegate", "cf_wait", "cf_close"]);
const text = (value: JsonValue, isError = false) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
  isError,
});

/**
 * Cross-runtime children run in their own harness Container and share the parent's
 * sandbox. Their events are relayed into the parent's stream under the child's
 * subagent and turn identifiers, so the API projects them like native subagents.
 */
export class Delegations {
  private readonly children = new Map<string, Child>();
  constructor(
    private readonly execution: Execution,
    private readonly options: DelegationOptions,
  ) {}
  get enabled(): boolean {
    return (this.execution.delegates?.length ?? 0) > 0;
  }
  get active(): boolean {
    return [...this.children.values()].some((child) => child.status === "in_progress");
  }
  definitions(): Tool[] {
    if (!this.enabled) return [];
    const aliases = (this.execution.delegates ?? []).map((delegate) => delegate.alias);
    return [
      {
        name: "cf_delegate",
        description: `Start a subagent on another configured runtime to work on a task in the shared workspace. Available models: ${aliases.join(", ")}. Returns its subagent_id; use cf_wait to collect its final answer.`,
        inputSchema: {
          type: "object",
          properties: {
            model: { type: "string", enum: aliases },
            prompt: { type: "string", description: "Complete task description for the subagent" },
            name: { type: "string" },
          },
          required: ["model", "prompt"],
          additionalProperties: false,
        },
      },
      {
        name: "cf_wait",
        description:
          "Wait for delegated subagents to finish and return their final answers. Omit subagent_ids to wait for all of them.",
        inputSchema: {
          type: "object",
          properties: {
            subagent_ids: { type: "array", items: { type: "string" } },
            timeout_ms: { type: "integer" },
          },
          additionalProperties: false,
        },
      },
      {
        name: "cf_close",
        description: "Cancel a delegated subagent that is no longer needed.",
        inputSchema: {
          type: "object",
          properties: { subagent_id: { type: "string" } },
          required: ["subagent_id"],
          additionalProperties: false,
        },
      },
    ];
  }
  owns(callId: string): Child | undefined {
    for (const child of this.children.values()) if (child.pending.has(callId)) return child;
    return undefined;
  }
  async call(name: string, args: unknown) {
    if (!this.enabled) throw new Error("Delegation is not enabled for this turn");
    if (name === "cf_delegate") return this.spawn(args);
    if (name === "cf_wait") return this.wait(args);
    if (name === "cf_close") return this.close(args);
    throw new Error("Unknown delegation tool");
  }
  private get timeouts() {
    return { ...DEFAULT_TIMEOUTS, ...this.options.timeouts };
  }
  private async request(
    path: string,
    body?: unknown,
    timeoutMs = this.timeouts.requestMs,
  ): Promise<Response> {
    const response = await fetch(`${this.options.endpoint.replace(/\/$/, "")}/${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.any([this.options.signal, AbortSignal.timeout(timeoutMs)]),
    });
    if (!response.ok) throw new DelegateRouteError(response.status, await response.text());
    return response;
  }
  private collaboration(
    operation: "spawnAgent" | "wait" | "closeAgent",
    recipients: string[],
    prompt: string | null,
    model: string | null,
    success: boolean,
  ) {
    this.options.emit({
      type: "collaboration",
      id: `collab_${crypto.randomUUID().replaceAll("-", "")}`,
      operation,
      recipients,
      prompt,
      model,
      effort: null,
      success,
    });
  }
  private async spawn(args: unknown) {
    const parsed = spawnSchema.safeParse(args);
    if (!parsed.success) return text({ error: "Provide model and prompt" }, true);
    const input = parsed.data;
    if (!this.execution.delegates?.some((delegate) => delegate.alias === input.model)) {
      this.collaboration("spawnAgent", [], input.prompt, input.model, false);
      return text({ error: `Unknown delegate model ${input.model}` }, true);
    }
    const limit = this.execution.maxConcurrentSubagents ?? 6;
    if (
      [...this.children.values()].filter((child) => child.status === "in_progress").length >= limit
    ) {
      this.collaboration("spawnAgent", [], input.prompt, input.model, false);
      return text({ error: `At most ${limit} subagents may run concurrently` }, true);
    }
    let started: { subagentId: string; turnId: string };
    try {
      started = z.object({ subagentId: z.string(), turnId: z.string() }).parse(
        await (
          await this.request(`${this.execution.turnId}/spawn`, {
            alias: input.model,
            prompt: input.prompt,
            name: input.name ?? null,
          })
        ).json(),
      );
    } catch (error) {
      this.options.diagnostics(`delegate spawn failed: ${String(error)}`);
      this.collaboration("spawnAgent", [], input.prompt, input.model, false);
      return text({ error: "Subagent could not be started" }, true);
    }
    let finish = () => {};
    const settled = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const child: Child = {
      subagentId: started.subagentId,
      turnId: started.turnId,
      alias: input.model,
      name: input.name ?? null,
      prompt: input.prompt,
      openedAt: Math.floor(Date.now() / 1000),
      cursor: 0,
      status: "in_progress",
      error: null,
      output: "",
      closed: false,
      pending: new Set(),
      settled,
      finish,
    };
    this.children.set(child.subagentId, child);
    this.options.emit({
      type: "subagent",
      id: child.subagentId,
      parentId: null,
      name: child.name,
      instructions: child.prompt,
      openedAt: child.openedAt,
      status: "active",
    });
    this.options.emit({
      type: "subagent_turn",
      id: child.turnId,
      subagentId: child.subagentId,
      status: "in_progress",
      startedAt: child.openedAt,
      completedAt: null,
    });
    this.collaboration("spawnAgent", [child.subagentId], input.prompt, input.model, true);
    // The relay owns its own failures; nothing here may become an unhandled rejection.
    this.follow(child).catch((error) => {
      this.options.diagnostics(`delegate relay crashed: ${String(error)}`);
    });
    return text({ subagent_id: child.subagentId, turn_id: child.turnId, status: "in_progress" });
  }
  /** Relay the child's runtime events until it stops; the relay owns the child's terminal state. */
  private async follow(child: Child): Promise<void> {
    try {
      while (!this.options.signal.aborted && child.status === "in_progress") {
        const batch = decode(
          batchSchema,
          await (
            await this.request(`${this.execution.turnId}/${child.subagentId}?after=${child.cursor}`)
          ).json(),
        );
        for (const { seq, event } of batch.events) {
          if (seq <= child.cursor) continue;
          if (seq !== child.cursor + 1) throw new Error("Child events must be contiguous");
          child.cursor = seq;
          this.relay(child, event);
        }
        if (batch.status === "running" || batch.status === "waiting") {
          await delay(this.options.pollIntervalMs ?? 500, undefined, {
            signal: this.options.signal,
          }).catch(() => {});
          continue;
        }
        this.terminate(
          child,
          batch.status === "missing" ? "failed" : batch.status,
          batch.status === "missing" ? "outcome_unknown" : (batch.error ?? null),
        );
      }
    } catch (error) {
      if (child.status === "in_progress") {
        this.options.diagnostics(`delegate relay failed: ${String(error)}`);
        this.terminate(
          child,
          this.options.signal.aborted ? "cancelled" : "failed",
          this.options.signal.aborted ? null : "subagent_relay_failed",
        );
      }
    }
  }
  private relay(child: Child, event: RuntimeEvent): void {
    // Children cannot delegate further; their own subagent bookkeeping is not projected.
    if (event.type === "subagent" || event.type === "subagent_turn") return;
    const scoped = { ...event, subagentId: child.subagentId, turnId: child.turnId };
    if (event.type === "function_call") child.pending.add(event.callId);
    if (event.type === "text" && event.phase === "final_answer") child.output = event.text;
    this.options.emit(scoped);
  }
  private terminate(
    child: Child,
    status: Exclude<ChildStatus, "in_progress">,
    error: string | null,
  ) {
    if (child.status !== "in_progress") return;
    child.status = status;
    child.error = error;
    child.pending.clear();
    this.options.emit({
      type: "subagent_turn",
      id: child.turnId,
      subagentId: child.subagentId,
      status,
      startedAt: child.openedAt,
      completedAt: Math.floor(Date.now() / 1000),
    });
    // Delegated children are single-turn: any terminal outcome closes the subagent,
    // and the record is published before anyone can seal the parent's outcome.
    this.closeRecord(child);
    child.finish();
    // Late workspace effects from abandoned code cannot be contained inside a shared sandbox.
    if (error === "programmatic_execution_uncertain") this.options.fail(error);
    this.options.settled?.();
  }
  private closeRecord(child: Child): void {
    if (child.closed) return;
    child.closed = true;
    this.options.emit({
      type: "subagent",
      id: child.subagentId,
      parentId: null,
      name: child.name,
      instructions: child.prompt,
      openedAt: child.openedAt,
      status: "closed",
    });
  }
  private result(child: Child) {
    return {
      subagent_id: child.subagentId,
      status: child.status,
      output: child.output,
      ...(child.error ? { error: child.error } : {}),
    };
  }
  private async wait(args: unknown) {
    const parsed = waitSchema.safeParse(args);
    if (!parsed.success) return text({ error: "Invalid wait arguments" }, true);
    const selected = parsed.data.subagent_ids
      ? parsed.data.subagent_ids.map((id) => this.children.get(id))
      : [...this.children.values()];
    if (selected.some((child) => !child)) {
      this.collaboration("wait", parsed.data.subagent_ids ?? [], null, null, false);
      return text({ error: "Unknown subagent_id" }, true);
    }
    const children = selected.filter((child): child is Child => !!child);
    const budget = Math.max(1, this.execution.deadline - Date.now() - 1_000);
    const timeout = Math.min(parsed.data.timeout_ms ?? budget, budget);
    const finished = await within(Promise.all(children.map((child) => child.settled)), timeout);
    this.collaboration(
      "wait",
      children.map((child) => child.subagentId),
      null,
      null,
      true,
    );
    return text({ complete: finished, subagents: children.map((child) => this.result(child)) });
  }
  private async close(args: unknown) {
    const parsed = closeSchema.safeParse(args);
    const child = parsed.success ? this.children.get(parsed.data.subagent_id) : undefined;
    if (!child) {
      this.collaboration("closeAgent", [], null, null, false);
      return text({ error: "Unknown subagent_id" }, true);
    }
    await this.cancel(child);
    this.closeRecord(child);
    this.collaboration("closeAgent", [child.subagentId], null, null, true);
    return text(this.result(child));
  }
  private async cancel(child: Child): Promise<void> {
    if (child.status !== "in_progress") return;
    try {
      await this.request(
        `${this.execution.turnId}/${child.subagentId}/control`,
        { operationId: `${child.turnId}:cancel`, command: { type: "cancel" } },
        this.timeouts.cancelMs,
      );
    } catch (error) {
      this.options.diagnostics(`delegate cancel failed: ${String(error)}`);
    }
    await within(child.settled, this.timeouts.requestMs);
  }
  /**
   * Route a client function result to the child that raised the call. A 409 from
   * the HarnessDO means the child already closed (the relay has not observed it
   * yet): the result can never apply, so the Worker must drop it, not retry.
   */
  async routeToolResult(
    child: Child,
    operationId: string,
    command: Extract<RuntimeCommand, { type: "tool_result" }>,
  ): Promise<void> {
    try {
      await this.request(`${this.execution.turnId}/${child.subagentId}/control`, {
        operationId,
        command,
      });
    } catch (error) {
      if (error instanceof DelegateRouteError && error.status === 409) {
        child.pending.delete(command.callId);
        throw new ApiError(
          409,
          "command_rejected",
          `Delegated subagent ${child.subagentId} no longer accepts tool results`,
        );
      }
      throw error;
    }
    child.pending.delete(command.callId);
  }
  /** Parent completion waits for children, as native Codex children do. */
  async settle(): Promise<void> {
    await Promise.all([...this.children.values()].map((child) => child.settled));
    for (const child of this.children.values()) this.closeRecord(child);
  }
  /**
   * Parent cancellation or shutdown: request cancellation, wait briefly for the
   * relay to observe it, then record the children as cancelled. The owning
   * HarnessDO stops child Containers regardless of what this relay observed.
   */
  async cancelAll(waitMs = this.timeouts.settleMs): Promise<void> {
    const active = [...this.children.values()].filter((child) => child.status === "in_progress");
    await Promise.all(
      active.map(async (child) => {
        try {
          await this.request(
            `${this.execution.turnId}/${child.subagentId}/control`,
            { operationId: `${child.turnId}:cancel`, command: { type: "cancel" } },
            this.timeouts.cancelMs,
          );
        } catch (error) {
          this.options.diagnostics(`delegate cancel failed: ${String(error)}`);
        }
      }),
    );
    await within(Promise.all(active.map((child) => child.settled)), waitMs);
    for (const child of active) this.terminate(child, "cancelled", null);
    for (const child of this.children.values()) this.closeRecord(child);
  }
}
