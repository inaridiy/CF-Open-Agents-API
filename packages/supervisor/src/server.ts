import {
  canonicalJSON,
  commandSchema,
  executionSchema,
  HARNESSES,
  workspaceRequestSchema,
} from "cf-open-agents-api";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { ClaudeCodeJob } from "./claude-code.js";
import { CodexJob, type CodexOptions } from "./codex.js";
import type { NativeJob, NativeOptions } from "./job.js";
import { OpenCodeJob } from "./opencode.js";

/** Private Container HTTP API. Its owning HarnessDO is the authorization boundary. */
export function createSupervisor(options: CodexOptions & NativeOptions) {
  let active: { job: NativeJob; fingerprint: string; started: Promise<void> } | undefined;
  const app = new Hono();
  app.use("*", bodyLimit({ maxSize: 48 * 1024 * 1024 }));
  app.onError((error) =>
    Response.json({ error: error.message }, { status: error instanceof z.ZodError ? 400 : 409 }),
  );
  app.get("/health", () => Response.json({ harnesses: HARNESSES, ready: true }));
  app.post("/jobs", async (c) => {
    const body = z
      .strictObject({
        execution: executionSchema,
        operationId: z.string(),
        checkpoint: z.unknown().optional(),
      })
      .parse(await c.req.json());
    const fingerprint = canonicalJSON(body.execution);
    if (active?.job.execution.turnId === body.execution.turnId) {
      if (active.fingerprint !== fingerprint)
        return Response.json({ error: "idempotency_conflict" }, { status: 409 });
      await active.started;
      return Response.json({ accepted: true });
    }
    if (active && body.execution.generation <= active.job.execution.generation)
      return Response.json({ error: "stale_generation" }, { status: 409 });
    if (active && !["completed", "cancelled", "failed"].includes(active.job.poll(0).status))
      return Response.json({ error: "active_execution" }, { status: 409 });
    const previous = active;
    const constructors = { codex: CodexJob, "claude-code": ClaudeCodeJob, opencode: OpenCodeJob };
    if (!Object.hasOwn(constructors, body.execution.harness))
      return Response.json({ error: "unsupported_harness" }, { status: 400 });
    const Job = constructors[body.execution.harness as keyof typeof constructors];
    const job: NativeJob = new Job(body.execution, options);
    // Publish ownership before the first await; duplicate HTTP requests join this start.
    const started = (async () => {
      try {
        await previous?.job.stop();
        await job.start(body.checkpoint);
      } catch (error) {
        job.failStart(error);
        await job.stop();
        throw error;
      }
    })();
    active = { job, fingerprint, started };
    await active.started;
    return Response.json({ accepted: true });
  });
  app.get("/jobs/:turn", (c) => {
    if (!active || active.job.execution.turnId !== c.req.param("turn"))
      return Response.json({ status: "missing", events: [], cursor: 0 });
    return Response.json(
      active.job.poll(
        z.coerce
          .number()
          .int()
          .min(0)
          .parse(c.req.query("after") ?? "0"),
      ),
    );
  });
  app.post("/jobs/:turn/control", async (c) => {
    if (!active || active.job.execution.turnId !== c.req.param("turn"))
      return Response.json({ error: "missing" }, { status: 404 });
    const body = z
      .strictObject({ operationId: z.string(), command: commandSchema })
      .parse(await c.req.json());
    await active.job.control(body.operationId, body.command);
    return c.body(null, 204);
  });
  app.get("/jobs/:turn/checkpoint", async (c) => {
    if (!active || active.job.execution.turnId !== c.req.param("turn"))
      return Response.json({ error: "missing" }, { status: 404 });
    return Response.json(await active.job.checkpoint());
  });
  app.all("/jobs/:turn/mcp", async (c) => {
    if (!active?.job.mcp || active.job.execution.turnId !== c.req.param("turn"))
      return c.body(null, 404);
    return active.job.mcp(c.req.raw);
  });
  app.post("/jobs/:turn/workspace", async (c) => {
    if (!active?.job.workspace || active.job.execution.turnId !== c.req.param("turn"))
      return c.body(null, 404);
    const input = workspaceRequestSchema.parse(await c.req.json());
    return Response.json(await active.job.workspace(input.tool, input.arguments));
  });
  app.post("/stop", async (c) => {
    await active?.job.stop();
    return c.body(null, 204);
  });
  return {
    app,
    stop: async () => {
      await active?.job.stop();
    },
  };
}
