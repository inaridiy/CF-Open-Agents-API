import { canonicalJSON, commandSchema, executionSchema } from "cf-open-agents-api";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { CodexJob, type CodexOptions } from "./codex.js";

/** Private Container HTTP API. Its owning HarnessDO is the authorization boundary. */
export function createSupervisor(options: CodexOptions) {
  let active: { job: CodexJob; fingerprint: string; started: Promise<void> } | undefined;
  const app = new Hono();
  app.use("*", bodyLimit({ maxSize: 48 * 1024 * 1024 }));
  app.onError((error) =>
    Response.json({ error: error.message }, { status: error instanceof z.ZodError ? 400 : 409 }),
  );
  app.get("/health", () => Response.json({ codex: "0.154.0", ready: true }));
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
    const job = new CodexJob(body.execution, options);
    // Publish ownership before the first await; duplicate HTTP requests join this start.
    const started = (async () => {
      try {
        await previous?.job.stop();
        await job.start(body.checkpoint);
      } catch (error) {
        job.failStart(error);
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
