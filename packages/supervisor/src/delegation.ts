import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  attempt,
  batchSchema,
  decodeEffect,
  type Execution,
  io,
  type JsonValue,
  type RuntimeCommand,
  type RuntimeEvent,
  type ServiceError,
} from "cf-open-agents-api";
import { Data, Deferred, Duration, Effect, type Scope } from "effect";
import { z } from "zod";

import {
  closeSubagent,
  closeSubagentTurn,
  nowSeconds,
  openSubagent,
  openSubagentTurn,
  randomId,
} from "./events.js";
import { CommandRejected, within } from "./lifecycle.js";

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
  /** Completed once the child reached a terminal status. */
  readonly settled: Deferred.Deferred<void>;
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
  /** Bounds for HarnessDO round trips; a stalled route must not hold the parent's lifecycle. */
  timeouts?: { requestMs?: number; cancelMs?: number; settleMs?: number };
}
const DEFAULT_TIMEOUTS = { requestMs: 30_000, cancelMs: 10_000, settleMs: 5_000 };
/** Pause between rounds of a child relay that is still running. */
const CHILD_POLL_INTERVAL = Duration.millis(500);
/** A HarnessDO delegate route answered with an error status. */
export class DelegateRouteError extends Data.TaggedError("DelegateRouteError")<{
  readonly status: number;
  readonly body: string;
}> {
  override get message(): string {
    return `Delegation request failed (${this.status}): ${this.body}`;
  }
}
/** A HarnessDO delegate route did not answer within its bound. */
export class DelegateTimeout extends Data.TaggedError("DelegateTimeout")<{
  readonly path: string;
}> {
  override get message(): string {
    return `Delegation request timed out: ${this.path}`;
  }
}
/** The turn has no delegates, or the model named a tool this module does not provide. */
export class DelegationUnavailable extends Data.TaggedError("DelegationUnavailable")<{
  readonly message: string;
}> {}
/** The child's relayed batch broke the contiguous-sequence contract. */
export class RelayError extends Data.TaggedError("RelayError")<{ readonly message: string }> {}
type RouteError = DelegateRouteError | DelegateTimeout | ServiceError;
export type DelegationResult = {
  content: { type: "text"; text: string }[];
  isError: boolean;
};

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
const startedSchema = z.object({ subagentId: z.string(), turnId: z.string() });
export const DELEGATION_TOOLS = new Set(["cf_delegate", "cf_wait", "cf_close"]);
const text = (value: JsonValue, isError = false): DelegationResult => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
  isError,
});

/**
 * Cross-runtime children run in their own harness Container and share the parent's
 * sandbox. Their events are relayed into the parent's stream under the child's
 * subagent and turn identifiers, so the API projects them like native subagents.
 * Each relay is a fiber forked into the caller's Scope; the parent job's resource
 * scope owns them.
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
  call(
    name: string,
    args: unknown,
  ): Effect.Effect<DelegationResult, DelegationUnavailable, Scope.Scope> {
    if (!this.enabled)
      return Effect.fail(
        new DelegationUnavailable({ message: "Delegation is not enabled for this turn" }),
      );
    if (name === "cf_delegate") return this.spawn(args);
    if (name === "cf_wait") return this.wait(args);
    if (name === "cf_close") return this.close(args);
    return Effect.fail(new DelegationUnavailable({ message: "Unknown delegation tool" }));
  }
  private get timeouts() {
    return { ...DEFAULT_TIMEOUTS, ...this.options.timeouts };
  }
  /**
   * One HarnessDO round trip, bounded by `timeoutMs`; the fiber's signal aborts the
   * fetch. Explicitly interruptible so the bound holds inside stop finalizers too.
   */
  private request(
    path: string,
    body?: unknown,
    timeoutMs = this.timeouts.requestMs,
  ): Effect.Effect<Response, RouteError> {
    return io("delegate.request", (signal) =>
      fetch(`${this.options.endpoint.replace(/\/$/, "")}/${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: body === undefined ? {} : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.any([this.options.signal, signal]),
      }),
    ).pipe(
      Effect.interruptible,
      Effect.filterOrElse(
        (response) => response.ok,
        (response) =>
          io("delegate.body", () => response.text()).pipe(
            Effect.flatMap((detail) =>
              Effect.fail(new DelegateRouteError({ status: response.status, body: detail })),
            ),
          ),
      ),
      Effect.timeoutFail({
        duration: Duration.millis(timeoutMs),
        onTimeout: () => new DelegateTimeout({ path }),
      }),
    );
  }
  private json(path: string): Effect.Effect<unknown, RouteError> {
    return this.request(path).pipe(
      Effect.flatMap((response) => io("delegate.json", () => response.json())),
    );
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
      id: randomId("collab"),
      operation,
      recipients,
      prompt,
      model,
      effort: null,
      success,
    });
  }
  private spawn(args: unknown): Effect.Effect<DelegationResult, never, Scope.Scope> {
    return Effect.gen(this, function* () {
      const parsed = spawnSchema.safeParse(args);
      if (!parsed.success) return text({ error: "Provide model and prompt" }, true);
      const input = parsed.data;
      if (!this.execution.delegates?.some((delegate) => delegate.alias === input.model)) {
        this.collaboration("spawnAgent", [], input.prompt, input.model, false);
        return text({ error: `Unknown delegate model ${input.model}` }, true);
      }
      const limit = this.execution.maxConcurrentSubagents ?? 6;
      if (
        [...this.children.values()].filter((child) => child.status === "in_progress").length >=
        limit
      ) {
        this.collaboration("spawnAgent", [], input.prompt, input.model, false);
        return text({ error: `At most ${limit} subagents may run concurrently` }, true);
      }
      const started = yield* this.request(`${this.execution.turnId}/spawn`, {
        alias: input.model,
        prompt: input.prompt,
        name: input.name ?? null,
      }).pipe(
        Effect.flatMap((response) => io("delegate.json", () => response.json())),
        Effect.flatMap((value) => attempt("delegate.spawn", () => startedSchema.parse(value))),
        Effect.either,
      );
      if (started._tag === "Left") {
        this.options.diagnostics(`delegate spawn failed: ${String(started.left)}`);
        this.collaboration("spawnAgent", [], input.prompt, input.model, false);
        return text({ error: "Subagent could not be started" }, true);
      }
      const child: Child = {
        subagentId: started.right.subagentId,
        turnId: started.right.turnId,
        alias: input.model,
        name: input.name ?? null,
        prompt: input.prompt,
        openedAt: nowSeconds(),
        cursor: 0,
        status: "in_progress",
        error: null,
        output: "",
        closed: false,
        pending: new Set(),
        settled: yield* Deferred.make<void>(),
      };
      this.children.set(child.subagentId, child);
      this.options.emit(
        openSubagent({
          id: child.subagentId,
          name: child.name,
          instructions: child.prompt,
          openedAt: child.openedAt,
        }),
      );
      this.options.emit(
        openSubagentTurn({
          id: child.turnId,
          subagentId: child.subagentId,
          startedAt: child.openedAt,
        }),
      );
      this.collaboration("spawnAgent", [child.subagentId], input.prompt, input.model, true);
      // The relay owns its own failures and is a fiber of the caller's Scope.
      yield* this.follow(child).pipe(Effect.forkScoped);
      return text({ subagent_id: child.subagentId, turn_id: child.turnId, status: "in_progress" });
    });
  }
  /** Relay the child's runtime events until it stops; the relay owns the child's terminal state. */
  private follow(child: Child): Effect.Effect<void> {
    return Effect.gen(this, function* () {
      while (!this.options.signal.aborted && child.status === "in_progress") {
        const batch = yield* decodeEffect(
          batchSchema,
          yield* this.json(`${this.execution.turnId}/${child.subagentId}?after=${child.cursor}`),
        );
        for (const { seq, event } of batch.events) {
          if (seq <= child.cursor) continue;
          if (seq !== child.cursor + 1)
            return yield* new RelayError({ message: "Child events must be contiguous" });
          child.cursor = seq;
          this.relay(child, event);
        }
        if (batch.status === "running" || batch.status === "waiting") {
          yield* Effect.sleep(CHILD_POLL_INTERVAL);
          continue;
        }
        this.terminate(
          child,
          batch.status === "missing" ? "failed" : batch.status,
          batch.status === "missing" ? "outcome_unknown" : (batch.error ?? null),
        );
      }
    }).pipe(
      Effect.catchAll((error) =>
        Effect.sync(() => {
          if (child.status !== "in_progress") return;
          this.options.diagnostics(`delegate relay failed: ${String(error)}`);
          this.terminate(
            child,
            this.options.signal.aborted ? "cancelled" : "failed",
            this.options.signal.aborted ? null : "subagent_relay_failed",
          );
        }),
      ),
    );
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
    this.options.emit(
      closeSubagentTurn({
        id: child.turnId,
        subagentId: child.subagentId,
        status,
        startedAt: child.openedAt,
      }),
    );
    // Delegated children are single-turn: any terminal outcome closes the subagent,
    // and the record is published before anyone can seal the parent's outcome.
    this.closeRecord(child);
    Deferred.unsafeDone(child.settled, Effect.void);
    // Late workspace effects from abandoned code cannot be contained inside a shared sandbox.
    if (error === "programmatic_execution_uncertain") this.options.fail(error);
    this.options.settled?.();
  }
  private closeRecord(child: Child): void {
    if (child.closed) return;
    child.closed = true;
    this.options.emit(
      closeSubagent({
        id: child.subagentId,
        name: child.name,
        instructions: child.prompt,
        openedAt: child.openedAt,
      }),
    );
  }
  private result(child: Child) {
    return {
      subagent_id: child.subagentId,
      status: child.status,
      output: child.output,
      ...(child.error ? { error: child.error } : {}),
    };
  }
  /** Resolves to whether every child settled before `ms` elapsed. */
  private settledWithin(children: Child[], ms: number): Effect.Effect<boolean> {
    return within(
      Effect.forEach(children, (child) => Deferred.await(child.settled), { discard: true }),
      Duration.millis(ms),
    );
  }
  private wait(args: unknown): Effect.Effect<DelegationResult> {
    return Effect.gen(this, function* () {
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
      const finished = yield* this.settledWithin(children, timeout);
      this.collaboration(
        "wait",
        children.map((child) => child.subagentId),
        null,
        null,
        true,
      );
      return text({ complete: finished, subagents: children.map((child) => this.result(child)) });
    });
  }
  private close(args: unknown): Effect.Effect<DelegationResult> {
    return Effect.gen(this, function* () {
      const parsed = closeSchema.safeParse(args);
      const child = parsed.success ? this.children.get(parsed.data.subagent_id) : undefined;
      if (!child) {
        this.collaboration("closeAgent", [], null, null, false);
        return text({ error: "Unknown subagent_id" }, true);
      }
      yield* this.cancel(child);
      this.closeRecord(child);
      this.collaboration("closeAgent", [child.subagentId], null, null, true);
      return text(this.result(child));
    });
  }
  private requestCancel(child: Child): Effect.Effect<void> {
    return this.request(
      `${this.execution.turnId}/${child.subagentId}/control`,
      { operationId: `${child.turnId}:cancel`, command: { type: "cancel" } },
      this.timeouts.cancelMs,
    ).pipe(
      Effect.asVoid,
      Effect.catchAll((error) =>
        Effect.sync(() => this.options.diagnostics(`delegate cancel failed: ${String(error)}`)),
      ),
    );
  }
  private cancel(child: Child): Effect.Effect<void> {
    return Effect.gen(this, function* () {
      if (child.status !== "in_progress") return;
      yield* this.requestCancel(child);
      yield* this.settledWithin([child], this.timeouts.requestMs);
    });
  }
  /**
   * Route a client function result to the child that raised the call. A 409 from
   * the HarnessDO means the child already closed (the relay has not observed it
   * yet): the result can never apply, so the Worker must drop it, not retry.
   */
  routeToolResult(
    child: Child,
    operationId: string,
    command: Extract<RuntimeCommand, { type: "tool_result" }>,
  ): Effect.Effect<void, CommandRejected | RouteError> {
    return Effect.gen(this, function* () {
      const routed = yield* this.request(`${this.execution.turnId}/${child.subagentId}/control`, {
        operationId,
        command,
      }).pipe(Effect.either);
      if (routed._tag === "Left") {
        if (routed.left._tag !== "DelegateRouteError" || routed.left.status !== 409)
          return yield* routed.left;
        child.pending.delete(command.callId);
        return yield* new CommandRejected({
          reason: `Delegated subagent ${child.subagentId} no longer accepts tool results`,
        });
      }
      child.pending.delete(command.callId);
    });
  }
  /** Parent completion waits for children, as native Codex children do. */
  settle(): Effect.Effect<void> {
    return Effect.gen(this, function* () {
      yield* Effect.forEach(this.children.values(), (child) => Deferred.await(child.settled), {
        discard: true,
      });
      for (const child of this.children.values()) this.closeRecord(child);
    });
  }
  /**
   * Parent cancellation or shutdown: request cancellation, wait briefly for the
   * relay to observe it, then record the children as cancelled. The owning
   * HarnessDO stops child Containers regardless of what this relay observed.
   */
  cancelAll(waitMs = this.timeouts.settleMs): Effect.Effect<void> {
    return Effect.gen(this, function* () {
      const active = [...this.children.values()].filter((child) => child.status === "in_progress");
      yield* Effect.forEach(active, (child) => this.requestCancel(child), {
        concurrency: "unbounded",
        discard: true,
      });
      yield* this.settledWithin(active, waitMs);
      for (const child of active) this.terminate(child, "cancelled", null);
      for (const child of this.children.values()) this.closeRecord(child);
    });
  }
}
