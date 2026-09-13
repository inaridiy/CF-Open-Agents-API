import {
  ApiError,
  canonicalJSON,
  commandSchema,
  decode,
  type Execution,
  executionSchema,
  HARNESSES,
  io,
  runPromise,
  workspaceRequestSchema,
} from "cf-open-agents-api";
import { Context, Effect, Layer, Ref, Schema } from "effect";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { ClaudeCodeJob } from "./claude-code.js";
import { CodexJob, type CodexOptions } from "./codex.js";
import type { NativeJob, NativeOptions } from "./job.js";
import { OpenCodeJob } from "./opencode.js";

type Options = CodexOptions & NativeOptions;
type JobFactory = (execution: Execution, options: Options) => NativeJob;
class NativeRuntime extends Context.Tag("supervisor/NativeRuntime")<
  NativeRuntime,
  {
    readonly create: JobFactory;
    readonly options: Options;
  }
>() {}
const createJob: JobFactory = (execution, options) => {
  switch (execution.harness) {
    case "codex":
      return new CodexJob(execution, options);
    case "claude-code":
      return new ClaudeCodeJob(execution, options);
    case "opencode":
      return new OpenCodeJob(execution, options);
    default:
      throw new ApiError(400, "unsupported_harness", "Unsupported harness");
  }
};
interface Active {
  readonly job: NativeJob;
  readonly fingerprint: string;
}

/** Private Container HTTP API. Its owning HarnessDO is the authorization boundary. */
export function createSupervisor(options: Options, factory: JobFactory = createJob) {
  const active = Ref.unsafeMake<Active | undefined>(undefined);
  // Serialize ownership changes and snapshots, while callbacks remain available during startup.
  const lifecycle = Effect.unsafeMakeSemaphore(1);
  const layer = Layer.succeed(NativeRuntime, { create: factory, options });
  const lookup = (turn: string) =>
    Effect.gen(function* () {
      const current = yield* Ref.get(active);
      if (!current || current.job.execution.turnId !== turn)
        return yield* new ApiError(404, "missing", "Execution is missing");
      return current.job;
    });
  const stop = lifecycle.withPermits(1)(
    Effect.gen(function* () {
      const current = yield* Ref.get(active);
      if (current) yield* io("supervisor.stop", () => current.job.stop());
    }),
  );
  const app = new Hono();
  app.use("*", bodyLimit({ maxSize: 48 * 1024 * 1024 }));
  app.onError((error) =>
    Response.json(
      { error: error instanceof ApiError ? error.code : error.message },
      {
        status: error instanceof z.ZodError ? 400 : error instanceof ApiError ? error.status : 409,
      },
    ),
  );
  app.get("/health", () => Response.json({ harnesses: HARNESSES, ready: true }));
  app.post("/jobs", async (c) => {
    const body = decode(
      Schema.Struct({
        execution: executionSchema,
        operationId: Schema.String,
        checkpoint: Schema.optional(Schema.Unknown),
      }),
      await c.req.json(),
    );
    return runPromise(
      lifecycle
        .withPermits(1)(
          Effect.gen(function* () {
            const runtime = yield* NativeRuntime;
            const previous = yield* Ref.get(active);
            const fingerprint = canonicalJSON({
              execution: body.execution,
              checkpoint: body.checkpoint,
            });
            if (previous?.job.execution.turnId === body.execution.turnId) {
              if (previous.fingerprint !== fingerprint)
                return yield* new ApiError(
                  409,
                  "idempotency_conflict",
                  "Execution parameters changed",
                );
              if (previous.job.status === "failed")
                return yield* new ApiError(
                  409,
                  "native_start_failed",
                  "Execution failed; it cannot be replayed",
                );
              return Response.json({ accepted: true });
            }
            if (previous && previous.job.execution.sessionId !== body.execution.sessionId)
              return yield* new ApiError(
                409,
                "assignment_conflict",
                "Supervisor belongs to another session",
              );
            if (previous && body.execution.generation <= previous.job.execution.generation)
              return yield* new ApiError(409, "stale_generation", "Execution was superseded");
            if (previous && !["completed", "cancelled", "failed"].includes(previous.job.status))
              return yield* new ApiError(409, "active_execution", "An execution is still active");
            if (!Object.hasOwn(HARNESSES, body.execution.harness))
              return yield* new ApiError(400, "unsupported_harness", "Unsupported harness");
            if (previous) yield* io("supervisor.stop", () => previous.job.stop());
            const job = runtime.create(body.execution, runtime.options);
            yield* Ref.set(active, { job, fingerprint });
            yield* io("supervisor.start", () => job.start(body.checkpoint)).pipe(
              Effect.onError((cause) =>
                Effect.gen(function* () {
                  job.failStart(cause);
                  yield* io("supervisor.cleanup", () => job.stop()).pipe(Effect.orDie);
                }),
              ),
            );
            return Response.json({ accepted: true });
          }),
        )
        .pipe(Effect.provide(layer)),
    );
  });
  app.get("/jobs/:turn", (c) =>
    runPromise(
      lookup(c.req.param("turn")).pipe(
        Effect.map((job) =>
          Response.json(
            job.poll(
              z.coerce
                .number()
                .int()
                .min(0)
                .parse(c.req.query("after") ?? "0"),
            ),
          ),
        ),
        Effect.catchTag("ApiError", () =>
          Effect.succeed(Response.json({ status: "missing", events: [], cursor: 0 })),
        ),
      ),
    ),
  );
  app.post("/jobs/:turn/control", async (c) => {
    const body = decode(
      Schema.Struct({ operationId: Schema.String, command: commandSchema }),
      await c.req.json(),
    );
    return runPromise(
      lifecycle.withPermits(1)(
        Effect.gen(function* () {
          const job = yield* lookup(c.req.param("turn"));
          yield* io("supervisor.control", () => job.control(body.operationId, body.command));
          return c.body(null, 204);
        }),
      ),
    );
  });
  app.get("/jobs/:turn/checkpoint", (c) =>
    runPromise(
      lifecycle.withPermits(1)(
        Effect.gen(function* () {
          const job = yield* lookup(c.req.param("turn"));
          return Response.json(yield* io("supervisor.checkpoint", () => job.checkpoint()));
        }),
      ),
    ),
  );
  app.all("/jobs/:turn/mcp", (c) =>
    runPromise(
      Effect.gen(function* () {
        const job = yield* lookup(c.req.param("turn"));
        const mcp = job.mcp?.bind(job);
        return mcp ? yield* io("supervisor.mcp", () => mcp(c.req.raw)) : c.body(null, 404);
      }),
    ),
  );
  app.post("/jobs/:turn/workspace", async (c) => {
    const input = workspaceRequestSchema.parse(await c.req.json());
    return runPromise(
      Effect.gen(function* () {
        const job = yield* lookup(c.req.param("turn"));
        const workspace = job.workspace?.bind(job);
        return workspace
          ? Response.json(
              yield* io("supervisor.workspace", () => workspace(input.tool, input.arguments)),
            )
          : c.body(null, 404);
      }),
    );
  });
  app.post("/stop", (c) => runPromise(stop.pipe(Effect.as(c.body(null, 204)))));
  return { app, stop: () => runPromise(stop) };
}
