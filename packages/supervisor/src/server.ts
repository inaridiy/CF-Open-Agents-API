import type { ApiError, OperationError } from "cf-open-agents-api";
import {
  canonicalJSON,
  commandSchema,
  type Execution,
  executionSchema,
  HARNESSES,
  type HarnessName,
  runPromise,
  workspaceRequestSchema,
} from "cf-open-agents-api";
import { Context, Data, Duration, Effect, Layer, Match, Option, Ref, Schema } from "effect";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

import type { CheckpointTooLarge, InvalidCheckpoint, InvalidCheckpointPath } from "./checkpoint.js";
import { ClaudeCodeJob } from "./claude-code.js";
import { CodexJob, type CodexOptions } from "./codex.js";
import type {
  DelegateRouteError,
  DelegateTimeout,
  DelegationUnavailable,
  RelayError,
} from "./delegation.js";
import {
  type DeferredToolNotDiscovered,
  type NativeJob,
  type NativeOptions,
  type ToolUnavailable,
} from "./job.js";
import type { RpcError, RpcTimeout, TransportClosed } from "./json-rpc.js";
import {
  AssignmentConflict,
  type CheckpointUnavailable,
  type CommandRejected,
  ExecutionActive,
  ExecutionAlreadyFailed,
  type ExecutionCancelled,
  ExecutionMissing,
  type ExecutionStopped,
  ExecutionSuperseded,
  IdempotencyConflict,
  type InvalidCursor,
  isTaggedFailure,
  UnsupportedHarness,
} from "./lifecycle.js";
import type { InvalidImageData, MediaUnavailable } from "./media.js";
import { OpenCodeJob } from "./opencode.js";
import type {
  NativeExited,
  NativeStartupFailed,
  NativeTurnFailed,
  ProcessGone,
  StartupTimeout,
} from "./process.js";
import type {
  CodeCallsOutstanding,
  CodeExecutionDisabled,
  CodeRunnerUnavailable,
  UnknownFunctionTool,
} from "./programmatic.js";
import type {
  McpCatalogInvalid,
  McpInputInvalid,
  McpRequestFailed,
  McpTimeout,
  McpToolUnknown,
} from "./remote-tools.js";
import type { NoSandboxAssignment, WorkspaceToolFailed } from "./workspace.js";

type Options = CodexOptions & NativeOptions;
/** Undefined when the execution names a harness this supervisor does not run. */
type JobFactory = (execution: Execution, options: Options) => NativeJob | undefined;
class NativeRuntime extends Context.Tag("supervisor/NativeRuntime")<
  NativeRuntime,
  {
    readonly create: JobFactory;
    readonly options: Options;
  }
>() {}
const factories: Record<HarnessName, (execution: Execution, options: Options) => NativeJob> = {
  codex: (execution, options) => new CodexJob(execution, options),
  "claude-code": (execution, options) => new ClaudeCodeJob(execution, options),
  opencode: (execution, options) => new OpenCodeJob(execution, options),
};
const isHarness = (name: string): name is HarnessName => Object.hasOwn(HARNESSES, name);
const createJob: JobFactory = (execution, options) =>
  isHarness(execution.harness) ? factories[execution.harness](execution, options) : undefined;
interface Active {
  readonly job: NativeJob;
  readonly fingerprint: string;
}
/** Upper bound for `GET /jobs/:turn?wait=`; the HarnessDO keeps its poll well under its fetch timeout. */
export const LONG_POLL_MAX_MS = 25_000;
const cursorQuery = z.coerce.number().int().min(0);

/** The request body or query did not validate; `issues` is the validator's report. */
export class InvalidRequest extends Data.TaggedError("InvalidRequest")<{
  readonly issues: string;
}> {
  override get message(): string {
    return this.issues;
  }
}
const parse = <T>(schema: z.ZodType<T>, input: unknown): Effect.Effect<T, InvalidRequest> =>
  Effect.suspend(() => {
    const result = schema.safeParse(input);
    return result.success
      ? Effect.succeed(result.data)
      : new InvalidRequest({ issues: z.prettifyError(result.error) });
  });
const decodeBody = <A, I>(schema: Schema.Schema<A, I>, input: unknown) =>
  Schema.decodeUnknown(schema, { onExcessProperty: "error" })(input).pipe(
    Effect.mapError((error) => new InvalidRequest({ issues: error.message })),
  );
const jobRequest = Schema.Struct({
  execution: executionSchema,
  operationId: Schema.String,
  checkpoint: Schema.optional(Schema.Unknown),
});
const controlRequest = Schema.Struct({ operationId: Schema.String, command: commandSchema });
const codeToolRequest = z.object({
  name: z.string(),
  arguments: z.json(),
  invocation: z.string().uuid(),
});

/**
 * Every tagged failure the supervisor can answer a request with. The one table below
 * gives each its status and code; nothing outside this module knows a status.
 */
type Known =
  | ApiError
  | OperationError
  | InvalidRequest
  | CommandRejected
  | ExecutionMissing
  | IdempotencyConflict
  | ExecutionSuperseded
  | AssignmentConflict
  | ExecutionActive
  | ExecutionAlreadyFailed
  | UnsupportedHarness
  | InvalidCheckpoint
  | ExecutionStopped
  | ExecutionCancelled
  | CheckpointUnavailable
  | InvalidCursor
  | CheckpointTooLarge
  | InvalidCheckpointPath
  | ToolUnavailable
  | DeferredToolNotDiscovered
  | UnknownFunctionTool
  | CodeExecutionDisabled
  | CodeRunnerUnavailable
  | CodeCallsOutstanding
  | NoSandboxAssignment
  | WorkspaceToolFailed
  | MediaUnavailable
  | InvalidImageData
  | McpCatalogInvalid
  | McpToolUnknown
  | McpInputInvalid
  | McpTimeout
  | McpRequestFailed
  | DelegateRouteError
  | DelegateTimeout
  | DelegationUnavailable
  | RelayError
  | NativeStartupFailed
  | NativeExited
  | NativeTurnFailed
  | RpcError
  | RpcTimeout
  | TransportClosed
  | ProcessGone
  | StartupTimeout;
type Verdict = readonly [status: ApiError["status"], code: string];
/**
 * Error contract for the HarnessDO: `{ code, message }` with the status of a known
 * failure. `409` means the request can never apply to this execution (a rejected
 * command, a start the slot refuses); `404 execution_missing` means no such job;
 * anything else is a transient failure worth retrying. `error` mirrors `code` for
 * older readers.
 */
const INTERNAL: Verdict = [500, "internal_error"];
const VERDICTS: Readonly<Record<Exclude<Known["_tag"], "ApiError">, Verdict>> = {
  InvalidRequest: [400, "invalid_request"],
  InvalidCheckpoint: [400, "invalid_request"],
  UnsupportedHarness: [400, "unsupported_harness"],
  ExecutionMissing: [404, "execution_missing"],
  CommandRejected: [409, "command_rejected"],
  IdempotencyConflict: [409, "idempotency_conflict"],
  ExecutionSuperseded: [409, "stale_generation"],
  AssignmentConflict: [409, "assignment_conflict"],
  ExecutionActive: [409, "active_execution"],
  ExecutionAlreadyFailed: [409, "native_start_failed"],
  OperationError: INTERNAL,
  ExecutionStopped: INTERNAL,
  ExecutionCancelled: INTERNAL,
  CheckpointUnavailable: INTERNAL,
  InvalidCursor: INTERNAL,
  CheckpointTooLarge: INTERNAL,
  InvalidCheckpointPath: INTERNAL,
  ToolUnavailable: INTERNAL,
  DeferredToolNotDiscovered: INTERNAL,
  UnknownFunctionTool: INTERNAL,
  CodeExecutionDisabled: INTERNAL,
  CodeRunnerUnavailable: INTERNAL,
  CodeCallsOutstanding: INTERNAL,
  NoSandboxAssignment: INTERNAL,
  WorkspaceToolFailed: INTERNAL,
  MediaUnavailable: INTERNAL,
  InvalidImageData: INTERNAL,
  McpCatalogInvalid: INTERNAL,
  McpToolUnknown: INTERNAL,
  McpInputInvalid: INTERNAL,
  McpTimeout: INTERNAL,
  McpRequestFailed: INTERNAL,
  DelegateRouteError: INTERNAL,
  DelegateTimeout: INTERNAL,
  DelegationUnavailable: INTERNAL,
  RelayError: INTERNAL,
  NativeStartupFailed: INTERNAL,
  NativeExited: INTERNAL,
  NativeTurnFailed: INTERNAL,
  RpcError: INTERNAL,
  RpcTimeout: INTERNAL,
  TransportClosed: INTERNAL,
  ProcessGone: INTERNAL,
  StartupTimeout: INTERNAL,
};
const isKnown = (error: unknown): error is Known =>
  isTaggedFailure(error) && (error._tag === "ApiError" || Object.hasOwn(VERDICTS, error._tag));
/** The library's own projection carries its status; every supervisor tag reads the table. */
const verdict = Match.type<Known>().pipe(
  Match.tag("ApiError", (error): Verdict => [error.status, error.code]),
  Match.orElse((error) => VERDICTS[error._tag]),
);
/** Every failure, tagged or not, becomes the `{ error, code, message }` answer. */
export function toResponse(error: unknown): Response {
  if (error instanceof HTTPException) return error.getResponse();
  const [status, code] = isKnown(error) ? verdict(error) : INTERNAL;
  const message = error instanceof Error ? error.message : String(error);
  return Response.json({ error: code, code, message }, { status });
}

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
      if (!current || current.job.execution.turnId !== turn) return yield* new ExecutionMissing();
      return current.job;
    });
  const stop = lifecycle.withPermits(1)(
    Effect.gen(function* () {
      const current = yield* Ref.get(active);
      if (current) yield* current.job.stop();
    }),
  );
  /** The slot's verdict on a start: replay, refuse, or hand the job to the caller. */
  const admit = (body: typeof jobRequest.Type) =>
    Effect.gen(function* () {
      const runtime = yield* NativeRuntime;
      const previous = yield* Ref.get(active);
      const fingerprint = canonicalJSON({
        execution: body.execution,
        checkpoint: body.checkpoint,
      });
      if (previous?.job.execution.turnId === body.execution.turnId) {
        if (previous.fingerprint !== fingerprint)
          return yield* new IdempotencyConflict({ reason: "Execution parameters changed" });
        if (previous.job.status === "failed") return yield* new ExecutionAlreadyFailed();
        return Option.none<NativeJob>();
      }
      if (previous && previous.job.execution.sessionId !== body.execution.sessionId)
        return yield* new AssignmentConflict();
      if (previous && body.execution.generation <= previous.job.execution.generation)
        return yield* new ExecutionSuperseded();
      if (previous && !["completed", "cancelled", "failed"].includes(previous.job.status))
        return yield* new ExecutionActive();
      const job = runtime.create(body.execution, runtime.options);
      if (!job) return yield* new UnsupportedHarness({ harness: body.execution.harness });
      if (previous) yield* previous.job.stop();
      yield* Ref.set(active, { job, fingerprint });
      return Option.some(job);
    });
  const app = new Hono();
  app.use("*", bodyLimit({ maxSize: 48 * 1024 * 1024 }));
  app.onError((error) => toResponse(error));
  app.get("/health", () => Response.json({ harnesses: HARNESSES, ready: true }));
  app.get("/diagnostics", () => Response.json({ lines: recent }));
  app.post("/jobs", async (c) => {
    const raw: unknown = await c.req.json();
    return runPromise(
      lifecycle
        .withPermits(1)(
          Effect.gen(function* () {
            const body = yield* decodeBody(jobRequest, raw);
            const job = yield* admit(body);
            // A replayed start is acknowledged again; the job failing is its own record.
            if (Option.isSome(job)) yield* job.value.start(body.checkpoint);
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
  app.get("/jobs/:turn", (c) =>
    runPromise(
      Effect.gen(function* () {
        const after = yield* parse(cursorQuery, c.req.query("after") ?? "0");
        const wait = Math.min(
          yield* parse(cursorQuery, c.req.query("wait") ?? "0"),
          LONG_POLL_MAX_MS,
        );
        const job = yield* lookup(c.req.param("turn"));
        return Response.json(yield* job.poll(after, Duration.millis(wait)));
      }).pipe(
        Effect.catchTag("ExecutionMissing", () =>
          Effect.succeed(Response.json({ status: "missing", events: [], cursor: 0 })),
        ),
      ),
    ),
  );
  app.post("/jobs/:turn/control", async (c) => {
    const raw: unknown = await c.req.json();
    return runPromise(
      lifecycle.withPermits(1)(
        Effect.gen(function* () {
          const body = yield* decodeBody(controlRequest, raw);
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
    const raw: unknown = await c.req.json();
    return runPromise(
      Effect.gen(function* () {
        const input = yield* parse(workspaceRequestSchema, raw);
        const job = yield* lookup(c.req.param("turn"));
        const workspace = job.workspace?.bind(job);
        return workspace
          ? Response.json(yield* workspace(input.tool, input.arguments))
          : c.body(null, 404);
      }),
    );
  });
  app.get("/jobs/:turn/code-tools", (c) =>
    runPromise(
      Effect.gen(function* () {
        const invocation = yield* parse(z.string().uuid(), c.req.query("invocation"));
        const job = yield* lookup(c.req.param("turn"));
        const codeTools = job.codeTools?.bind(job);
        return codeTools ? Response.json(yield* codeTools(invocation)) : c.body(null, 404);
      }),
    ),
  );
  app.post("/jobs/:turn/code-tool", async (c) => {
    const raw: unknown = await c.req.json();
    return runPromise(
      Effect.gen(function* () {
        const input = yield* parse(codeToolRequest, raw);
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
