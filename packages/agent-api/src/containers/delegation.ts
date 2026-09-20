import { Effect, Schema } from "effect";
import { z } from "zod";

import { attempt, decodeEffect, io } from "../effect.js";
import type { Assignment } from "../persistence/harness-kinds.js";
import type { Execution } from "../runtime.js";
import { batchSchema, commandSchema } from "../runtime.js";
import { assignment, type HarnessHost, read, write } from "./host.js";

const spawnRequestSchema = z.object({
  alias: z.string().min(1),
  prompt: z.string().min(1).max(128_000),
  name: z.string().max(256).nullable().optional(),
});
/**
 * Private route for the parent supervisor: start, poll and control delegated
 * children. Children run in their own HarnessDO and Container but share the
 * parent's sandbox; the parent's assignment remains the authorization boundary.
 */
export function delegateRequest(host: HarnessHost, request: Request) {
  return Effect.gen(function* () {
    const current = yield* assignment;
    const url = new URL(request.url);
    const [turnId, target, action] = url.pathname.split("/").slice(1);
    const delegation = current.delegation;
    if (current.revoked || turnId !== current.turnId || !delegation)
      return new Response("Delegation is not available for this execution", { status: 403 });
    if (request.method === "POST" && target === "spawn" && !action)
      return yield* spawnChild(
        host,
        current,
        delegation,
        yield* io("delegate.body", () => request.json()),
      );
    if (!target) return new Response(null, { status: 404 });
    const child = yield* read((tx) => tx.child(target));
    if (!child || child.execution.parent?.turnId !== turnId)
      return new Response("Unknown subagent", { status: 404 });
    if (request.method === "GET" && !action) {
      if (child.terminal) return Response.json(child.terminal);
      const after = yield* attempt("delegate.cursor", () =>
        z.coerce
          .number()
          .int()
          .min(0)
          .parse(url.searchParams.get("after") ?? "0"),
      );
      const polled = yield* io("delegate.poll", () =>
        host.child(target).pollExecution(child.execution, after),
      );
      const batch = yield* decodeEffect(
        batchSchema,
        yield* io("delegate.poll", () => polled.json()),
      );
      if (batch.status !== "running" && batch.status !== "waiting") {
        // Durable before the child Container disappears, so a lost response can be retried.
        yield* write((tx) => tx.putChild(target, { ...child, terminal: batch }));
        yield* io("delegate.stop", () => host.child(target).stopExecution(child.execution)).pipe(
          Effect.catchAll((error) =>
            Effect.logWarning("Delegated child stop failed", { error: String(error) }),
          ),
        );
      }
      return Response.json(batch);
    }
    if (request.method === "POST" && action === "control") {
      if (child.terminal) return new Response("Subagent has stopped", { status: 409 });
      const body = yield* decodeEffect(
        Schema.Struct({ operationId: Schema.String, command: commandSchema }),
        yield* io("delegate.body", () => request.json()),
      );
      yield* io("delegate.control", () =>
        host.child(target).controlExecution(child.execution, body.operationId, body.command),
      );
      return new Response(null, { status: 204 });
    }
    return new Response(null, { status: 404 });
  });
}
function spawnChild(
  host: HarnessHost,
  current: Assignment,
  delegation: NonNullable<Assignment["delegation"]>,
  input: unknown,
) {
  return Effect.gen(function* () {
    const parsed = spawnRequestSchema.safeParse(input);
    if (!parsed.success) return new Response("Invalid spawn request", { status: 400 });
    const delegate = delegation.delegates.find((entry) => entry.alias === parsed.data.alias);
    if (!delegate) return new Response("Unknown delegate", { status: 404 });
    const children = current.children ?? [];
    const active = yield* read((tx) => children.filter((id) => !tx.child(id)?.terminal).length);
    if (active >= delegation.maxConcurrentSubagents)
      return new Response("Concurrent subagent limit reached", { status: 409 });
    const subagentId = `subagent_${crypto.randomUUID().replaceAll("-", "")}`;
    const turnId = `turn_${crypto.randomUUID().replaceAll("-", "")}`;
    const execution: Execution = {
      sessionId: current.sessionId,
      turnId,
      generation: current.generation,
      harness: delegate.harness,
      model: delegate.model,
      ...(delegate.tiers ? { tiers: delegate.tiers } : {}),
      agent: {
        model: delegate.alias,
        instructions: delegation.agent.instructions ?? null,
        // Children keep the parent's client, MCP and code tools; provider search follows the child runtime.
        tools: (delegation.agent.tools ?? []).filter(
          (tool) => tool.type !== "web_search" || delegate.harness === "codex",
        ),
        reasoning: delegation.agent.reasoning ?? null,
        multi_agent: { enabled: false },
      },
      input: [{ role: "user", content: [{ type: "input_text", text: parsed.data.prompt }] }],
      checkpoint: null,
      deadline: delegation.deadline,
      sandbox: current.sandbox,
      ...(delegation.environmentId ? { environmentId: delegation.environmentId } : {}),
      capabilityRoots: host.environment.capabilityRoots(),
      ...(current.tenant ? { tenant: current.tenant } : {}),
      ...(current.vaultIds ? { vaultIds: [...current.vaultIds] } : {}),
      parent: { turnId: current.turnId, subagentId },
    };
    yield* write((tx) => {
      tx.putChild(subagentId, { execution });
      tx.putAssignment({ ...current, children: [...children, subagentId] });
    });
    const started = yield* io("delegate.start", () =>
      host.child(subagentId).startExecution(execution, `${turnId}:start`),
    ).pipe(Effect.either);
    if (started._tag === "Left") {
      yield* Effect.logWarning("Delegated child start failed", {
        subagentId,
        error: String(started.left),
      });
      yield* write((tx) =>
        tx.putChild(subagentId, {
          execution,
          terminal: { status: "failed", events: [], cursor: 0, error: "subagent_start_failed" },
        }),
      );
      yield* io("delegate.stop", () => host.child(subagentId).stopExecution(execution)).pipe(
        Effect.ignore,
      );
      return new Response("Subagent could not be started", { status: 502 });
    }
    return Response.json({ subagentId, turnId });
  });
}
