import {
  ApiError,
  canonicalJSON,
  commandSchema,
  decode,
  type Execution,
  executionSchema,
  HARNESSES,
  runPromise,
  workspaceRequestSchema,
} from "cf-open-agents-api";
import { Context, Duration, Effect, Layer, Ref, Schema } from "effect";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
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
/** Upper bound for `GET /jobs/:turn?wait=`; the HarnessDO keeps its poll well under its fetch timeout. */
export const LONG_POLL_MAX_MS = 25_000;
const cursorQuery = z.coerce.number().int().min(0);

/** Private Container HTTP API. Its owning HarnessDO is the authorization boundary. */
export function createSupervisor(options: Options, factory: JobFactory = createJob) {
  const active = Ref.unsafeMake<Active | undefined>(void 0);
  // Bounded native stderr tail so the Worker can log why an execution failed.
  const recent: string[] = [];
  const forward = options.diagnostics;
  const diagnostics = (line: string) => {
    forward(line);
    recent.push(line.length > 4096 ? `${line.slice(0, 4096)}…` : line);
    if (recent.length > 200) recent.shift();
  };
  const configured: Options = { ...options, diagnostics };
  // Serialize ownership changes and snapshots, while callbacks remain available during startup.
  const lifecycle = Effect.unsafeMakeSemaphore(1);
  const layer = Layer.succeed(NativeRuntime, { create: factory, options: configured });
  const lookup = (turn: string) =>
    Effect.gen(function* () {
      const current = yield* Ref.get(active);
      if (!current || current.job.execution.turnId !== turn)
        return yield* new ApiError(404, "execution_missing", "Execution is missing");
      return current.job;
    });
  const stop = lifecycle.withPermits(1)(
    Effect.gen(function* () {
      const current = yield* Ref.get(active);
      if (current) yield* current.job.stop();
    }),
  );
  const app = new Hono();
  app.use("*", bodyLimit({ maxSize: 48 * 1024 * 1024 }));
  /**
   * Error contract for the HarnessDO: `{ code, message }` with the status of a
   * known failure. `409 command_rejected` means the command can never apply to
   * this execution; `404 execution_missing` means no such job; anything else is
   * a transient failure worth retrying. `error` mirrors `code` for older readers.
   */
  app.onError((error) => {
    if (error instanceof HTTPException) return error.getResponse();
    const known =
      error instanceof z.ZodError
        ? new ApiError(400, "invalid_request", z.prettifyError(error))
        : error instanceof ApiError
          ? error
          : undefined;
    const code = known?.code ?? "internal_error";
    return Response.json(
      { error: code, code, message: known?.message ?? error.message },
      { status: known?.status ?? 500 },
    );
  });
  app.get("/health", () => Response.json({ harnesses: HARNESSES, ready: true }));
  app.get("/diagnostics", () => Response.json({ lines: recent }));
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
            if (previous) yield* previous.job.stop();
            const job = runtime.create(body.execution, runtime.options);
            yield* Ref.set(active, { job, fingerprint });
            yield* job
              .start(body.checkpoint)
              .pipe(
                Effect.onError((cause) =>
                  Effect.sync(() => job.failStart(cause)).pipe(Effect.zipRight(job.stop())),
                ),
              );
            return Response.json({ accepted: true });
          }),
        )
        .pipe(Effect.provide(layer)),
    );
  });
  /**
   * `?after=N` answers at once with the retained events after `N`. `&wait=<ms>`
   * (capped at 25 s) makes an empty answer wait that long for the next event or
   * terminal outcome; a missing execution and terminal outcomes never wait.
   */
  app.get("/jobs/:turn", (c) => {
    const after = cursorQuery.parse(c.req.query("after") ?? "0");
    const wait = Math.min(cursorQuery.parse(c.req.query("wait") ?? "0"), LONG_POLL_MAX_MS);
    return runPromise(
      lookup(c.req.param("turn")).pipe(
        Effect.flatMap((job) => job.poll(after, Duration.millis(wait))),
        Effect.map((batch) => Response.json(batch)),
        Effect.catchTag("ApiError", () =>
          Effect.succeed(Response.json({ status: "missing", events: [], cursor: 0 })),
        ),
      ),
    );
  });
  app.post("/jobs/:turn/control", async (c) => {
    const body = decode(
      Schema.Struct({ operationId: Schema.String, command: commandSchema }),
      await c.req.json(),
    );
    return runPromise(
      lifecycle.withPermits(1)(
        Effect.gen(function* () {
          const job = yield* lookup(c.req.param("turn"));
          yield* job.control(body.operationId, body.command);
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
          return Response.json(yield* job.checkpoint());
        }),
      ),
    ),
  );
  app.all("/jobs/:turn/mcp", (c) =>
    runPromise(
      Effect.gen(function* () {
        const job = yield* lookup(c.req.param("turn"));
        const mcp = job.mcp?.bind(job);
        return mcp ? yield* mcp(c.req.raw) : c.body(null, 404);
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
          ? Response.json(yield* workspace(input.tool, input.arguments))
          : c.body(null, 404);
      }),
    );
  });
  app.get("/jobs/:turn/code-tools", (c) => {
    const invocation = z.string().uuid().parse(c.req.query("invocation"));
    return runPromise(
      Effect.gen(function* () {
        const job = yield* lookup(c.req.param("turn"));
        const codeTools = job.codeTools?.bind(job);
        return codeTools ? Response.json(yield* codeTools(invocation)) : c.body(null, 404);
      }),
    );
  });
  app.post("/jobs/:turn/code-tool", async (c) => {
    const input = z
      .object({ name: z.string(), arguments: z.json(), invocation: z.string().uuid() })
      .parse(await c.req.json());
    return runPromise(
      Effect.gen(function* () {
        const job = yield* lookup(c.req.param("turn"));
        const codeTool = job.codeTool?.bind(job);
        return codeTool
          ? Response.json(yield* codeTool(input.name, input.arguments, input.invocation))
          : c.body(null, 404);
      }),
    );
  });
  app.post("/stop", (c) => runPromise(stop.pipe(Effect.as(c.body(null, 204)))));
  return { app, stop: () => runPromise(stop), shutdown: stop };
}
