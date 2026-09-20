import { getSandbox } from "@cloudflare/sandbox";
import { Effect, Stream } from "effect";
import { z } from "zod";

import { attempt, io, type ServiceError } from "../effect.js";
import { InvalidJson, Superseded, TransportFailure } from "../errors.js";
import { HARNESSES } from "../harnesses.js";
import { proxyMcp } from "../mcp.js";
import { fetchAssignedImage } from "../media.js";
import { readModelBodyEffect } from "../models/body.js";
import { constrainCodexSearch } from "../models/codex-search.js";
import { programmaticInputSchema } from "../programmatic-contract.js";
import { runProgrammatic } from "../programmatic.js";
import { executeWorkspaceTool } from "../sandbox-tools.js";
import { modelAllowed, permittedCodeTool, sha256Hex, superseded } from "./assignment.js";
import { assignment, type ContainerBindings, type HarnessHost, write } from "./host.js";

/**
 * The outbound hosts a harness container reaches through the Container's handler, each
 * answered by the HarnessDO that owns the container. The assignment is the authorization
 * boundary of every one of them.
 */
export function mediaRequest(request: Request) {
  return Effect.gen(function* () {
    const current = yield* assignment;
    const url = new URL(request.url);
    const source = url.searchParams.get("url");
    const refused = new Response("Image is not assigned to this execution", { status: 403 });
    if (request.method !== "GET" || url.pathname !== "/image" || current.revoked || !source)
      return refused;
    const digest = yield* io("assignment.image", () => sha256Hex(source));
    if (!current.imageDigests?.includes(digest)) return refused;
    return yield* io("assignment.image", () => fetchAssignedImage(source, request.signal));
  });
}
export function programmaticRequest(host: HarnessHost, request: Request) {
  return Effect.gen(function* () {
    const current = yield* assignment;
    const loader = host.env.CODE_LOADER;
    if (
      request.method !== "POST" ||
      new URL(request.url).pathname !== `/${current.turnId}` ||
      !current.programmatic ||
      current.revoked ||
      !loader
    )
      return new Response("No code runner assigned", { status: 403 });
    const programmatic = current.programmatic;
    // Other entrypoints (a newer start, a cancel, a stop) abort running code through
    // this controller; the request's own fiber ends it when the response is built.
    const controller = new AbortController();
    host.codeExecutions.add(controller);
    const execute = Effect.gen(function* () {
      const input = yield* io("programmatic.input", async () =>
        programmaticInputSchema.parse(await request.json()),
      );
      const invocation = yield* attempt("programmatic.invocation", () =>
        z.string().uuid().parse(request.headers.get("x-cf-code-invocation")),
      );
      const catalog = yield* io("programmatic.catalog", () =>
        host.containerFetch(
          `http://harness/jobs/${current.turnId}/code-tools?invocation=${invocation}`,
        ),
      );
      if (!catalog.ok)
        return yield* new TransportFailure({
          operation: "programmatic.catalog",
          cause: "Code tool catalog is unavailable",
        });
      // The container proposes names; the Worker's assignment decides what code may call.
      const tools = yield* io("programmatic.tools", async () =>
        z
          .array(z.string().min(1).max(256))
          .max(2000)
          .parse(await catalog.json())
          .filter((name) => permittedCodeTool(current, name)),
      );
      return yield* io("programmatic.run", () =>
        runProgrammatic(loader, {
          input,
          tools,
          signal: controller.signal,
          timeoutMs: programmatic.deadline - Date.now(),
          call: async (name, args, signal) => {
            // The runtime calls back outside any fiber: the synchronous view answers.
            const latest = host.tx.requireAssignment();
            if (latest.revoked || superseded(latest, current))
              throw new Error("Execution was superseded");
            if (!permittedCodeTool(latest, name)) throw new Error("Tool is not allowed");
            const result = await host.containerFetch(
              new Request(`http://harness/jobs/${current.turnId}/code-tool`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ name, arguments: args, invocation }),
                signal,
              }),
            );
            if (!result.ok) throw new Error("Programmatic tool call failed");
            return result.json();
          },
        }),
      );
    });
    const failed = (error: ServiceError) =>
      Effect.gen(function* () {
        // A tool call ended without a confirmed result: the code may have had effects.
        const terminal = error._tag === "ProgrammaticOutcomeUncertain";
        if (terminal) {
          // A child reports the uncertain outcome; its parent's failure destroys the shared sandbox.
          const revoked = yield* write((tx) => {
            const latest = tx.requireAssignment();
            if (superseded(latest, current)) return false;
            tx.putAssignment({ ...latest, revoked: true });
            if (current.sandbox && !current.parent) tx.forgetSandbox();
            return true;
          });
          if (revoked && current.sandbox && !current.parent)
            yield* io("programmatic.destroy", () =>
              getSandbox(host.env.SANDBOX, current.sessionId).destroy(),
            );
        }
        return Response.json({
          content: [{ type: "text", text: programmaticFailureText(error) }],
          isError: true,
          terminal,
        });
      });
    return yield* execute.pipe(
      Effect.map((value) =>
        Response.json({
          content: [{ type: "text", text: JSON.stringify(value) }],
          isError: false,
        }),
      ),
      Effect.catchAll(failed),
      Effect.ensuring(
        Effect.sync(() => {
          controller.abort();
          host.codeExecutions.delete(controller);
        }),
      ),
    );
  });
}
export function mcpRequest(host: HarnessHost, request: Request) {
  return Effect.gen(function* () {
    const current = yield* assignment;
    if (current.revoked) return new Response("Execution authority was revoked", { status: 409 });
    const tool = current.mcp?.find(
      (entry) => `/${entry.server_label}` === new URL(request.url).pathname,
    );
    if (!tool) return new Response(null, { status: 404 });
    if (tool.transport.type === "stdio" || tool.connection_origin === "environment") {
      if (!current.sandbox || current.harness === "codex")
        return new Response(null, { status: 404 });
      const url = new URL(request.url);
      url.hostname = "environment-mcp.internal";
      return yield* io("mcp.environment", (signal) =>
        host.env.SANDBOX.getByName(current.sessionId).fetch(
          new Request(new Request(url, request), {
            signal: AbortSignal.any([request.signal, signal]),
          }),
        ),
      );
    }
    const serverURL = tool.transport.server_url;
    const tenant = current.tenant;
    const token = tenant
      ? yield* io("mcp.credential", () =>
          host.env.CATALOG.getByName(tenant).mcpToken(
            [...(current.vaultIds ?? [])],
            serverURL,
            tool.credential_id,
          ),
        )
      : undefined;
    const sender = host.env.MCP;
    return yield* proxyMcp(
      request,
      tool,
      token,
      sender ? (outbound) => sender.fetch(outbound) : fetch,
    );
  });
}
export function sandboxRequest(host: HarnessHost, request: Request) {
  return Effect.gen(function* () {
    const current = yield* assignment;
    if (current.revoked) return new Response("Execution authority was revoked", { status: 409 });
    if (!current.sandbox) return new Response("No sandbox assigned", { status: 403 });
    if (new URL(request.url).pathname !== "/tools" || request.method !== "POST")
      return yield* io("sandbox.proxy", () =>
        host.env.SANDBOX.getByName(current.sessionId).fetch(request),
      );
    const input = yield* io("workspace.tool.body", () => request.json());
    // The assignment is re-read under the workspace permit, right before the tool runs.
    const operation = (onOutput?: (text: string) => void) =>
      host.workspace.withPermits(1)(
        Effect.gen(function* () {
          const latest = yield* attempt("workspace.assignment", () => host.tx.requireAssignment());
          if (latest.revoked || superseded(latest, current))
            return yield* new Superseded({
              turnId: current.turnId,
              generation: current.generation,
            });
          return yield* io("workspace.tool", async (signal) => {
            signal.throwIfAborted();
            return executeWorkspaceTool(
              getSandbox(host.env.SANDBOX, current.sessionId),
              input,
              onOutput ? { onOutput, signal } : undefined,
            );
          });
        }),
      );
    if (request.headers.get("accept") !== "application/x-ndjson")
      return yield* operation().pipe(
        Effect.map((result) => Response.json(result)),
        Effect.orElseSucceed(() =>
          Response.json({ error: "Workspace operation failed" }, { status: 422 }),
        ),
      );
    const line = (value: unknown) => `${JSON.stringify(value)}\n`;
    // The response stream owns the operation: cancelling it interrupts the fiber, which
    // aborts the command through the signal and releases the workspace permit.
    const lines = Stream.asyncPush<string>((emit) =>
      Effect.forkScoped(
        operation((text) => emit.single(line({ type: "delta", text }))).pipe(
          Effect.match({
            onSuccess: (result) => emit.single(line({ type: "result", ...result })),
            onFailure: () =>
              emit.single(line({ type: "error", message: "Workspace operation failed" })),
          }),
          Effect.ensuring(Effect.sync(() => emit.end())),
        ),
      ),
    );
    const body = yield* Stream.toReadableStreamEffect(lines.pipe(Stream.encodeText));
    return new Response(body, { headers: { "content-type": "application/x-ndjson" } });
  });
}
export function modelRequest(host: HarnessHost, request: Request) {
  return Effect.gen(function* () {
    const current = yield* assignment;
    if (current.revoked) return new Response("Execution authority was revoked", { status: 409 });
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== HARNESSES[current.harness].protocol)
      return new Response("Unsupported model request", { status: 403 });
    const bytes = yield* readModelBodyEffect(request);
    const body = yield* attempt("modelRequest.body", (): unknown =>
      JSON.parse(new TextDecoder().decode(bytes)),
    ).pipe(Effect.mapError(() => new InvalidJson()));
    if (typeof body !== "object" || body === null || Array.isArray(body))
      return yield* new InvalidJson();
    const parsed = body as Record<string, unknown>;
    if (!modelAllowed(current, parsed.model))
      return new Response("Model is not assigned to this execution", { status: 403 });
    const latest = yield* assignment;
    if (superseded(latest, current))
      return new Response("Execution was superseded", { status: 409 });
    return yield* io("modelRequest", (signal) =>
      host.env.MODEL_GATEWAY.fetch(
        new Request(request, {
          ...(request.method === "GET" || request.method === "HEAD"
            ? {}
            : {
                body:
                  current.harness === "codex" && current.webSearchMode !== undefined
                    ? JSON.stringify(constrainCodexSearch(parsed, current.webSearchMode))
                    : bytes,
              }),
          signal: AbortSignal.any([request.signal, signal]),
        }),
      ),
    );
  }).pipe(
    // The container sent something that is not a JSON object: a definite 400, not a defect.
    Effect.catchTag("InvalidJson", () =>
      Effect.succeed(new Response("Model request body is not a JSON object", { status: 400 })),
    ),
  );
}
/** What generated code sees of its failure: its own error text, or nothing about the platform. */
function programmaticFailureText(error: ServiceError): string {
  switch (error._tag) {
    case "ProgrammaticExecutionFailed":
    case "ProgrammaticOutcomeUncertain":
    case "ProgrammaticInputTooLarge":
      return error.message;
    default:
      return "Code execution failed";
  }
}

// The SDK registers handlers through its static setter. Class fields bypass it.
export const outboundByHost = {
  "media.internal": async (request: Request, bindings: unknown, ctx: { containerId: string }) => {
    const env = bindings as ContainerBindings;
    return env.HARNESS.get(env.HARNESS.idFromString(ctx.containerId)).mediaRequest(request);
  },
  "programmatic.internal": async (
    request: Request,
    bindings: unknown,
    ctx: { containerId: string },
  ) => {
    const env = bindings as ContainerBindings;
    return env.HARNESS.get(env.HARNESS.idFromString(ctx.containerId)).programmaticRequest(request);
  },
  "mcp.internal": async (request: Request, bindings: unknown, ctx: { containerId: string }) => {
    const env = bindings as ContainerBindings;
    return env.HARNESS.get(env.HARNESS.idFromString(ctx.containerId)).mcpRequest(request);
  },
  "delegate.internal": async (
    request: Request,
    bindings: unknown,
    ctx: { containerId: string },
  ) => {
    const env = bindings as ContainerBindings;
    return env.HARNESS.get(env.HARNESS.idFromString(ctx.containerId)).delegateRequest(request);
  },
  "sandbox.internal": async (request: Request, bindings: unknown, ctx: { containerId: string }) => {
    const env = bindings as ContainerBindings;
    return env.HARNESS.get(env.HARNESS.idFromString(ctx.containerId)).fetch(request);
  },
  "model.internal": async (request: Request, bindings: unknown, ctx: { containerId: string }) => {
    const env = bindings as ContainerBindings;
    return env.HARNESS.get(env.HARNESS.idFromString(ctx.containerId)).modelRequest(request);
  },
};
