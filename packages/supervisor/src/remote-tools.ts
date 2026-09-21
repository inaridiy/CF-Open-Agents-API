import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  attempt,
  type Execution,
  io,
  type JsonValue,
  OperationError,
  type RuntimeEvent,
  type ServiceError,
} from "cf-open-agents-api";
import { Data, Duration, Effect, ExecutionStrategy, Exit, Scope } from "effect";
import { z } from "zod";

import { type Attribution, randomId } from "./events.js";
import type { ToolScope } from "./job.js";

type McpServer = Extract<NonNullable<Execution["agent"]["tools"]>[number], { type: "mcp" }>;
/** Bound for one remote tool call; the SDK's own request timer sits behind it as a backstop. */
const CALL_TIMEOUT = Duration.seconds(120);
const reason = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/**
 * Walk a cursor-paginated MCP catalog. `page` reads one page, records what it found
 * and answers with the next cursor; a cursor that repeats would never terminate, so
 * `stalled` says how that reads to the caller. The two catalogs differ in everything
 * else: an MCP client lists tools here, the Codex app-server lists servers there.
 */
export function paginate<E, R>(
  page: (cursor: string | undefined) => Effect.Effect<string | undefined, E, R>,
  stalled: () => E,
): Effect.Effect<void, E, R> {
  // A loop, not recursion: a server that keeps handing out cursors must cost the
  // walk memory in `seen`, never stack frames.
  return Effect.gen(function* () {
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (;;) {
      const next = yield* page(cursor);
      if (!next) return;
      if (seen.has(next)) return yield* Effect.fail(stalled());
      seen.add(next);
      cursor = next;
    }
  });
}
/** A remote tool reports its own failure in the payload; anything else succeeded. */
const succeeded = (output: JsonValue | null): boolean =>
  !(output !== null && typeof output === "object" && "isError" in output && output.isError);
/**
 * Report one remote tool call as an `mcp` event whatever its outcome, then hand the
 * result or the failure on unchanged. Only the reporting is shared: `RemoteTools`
 * calls an MCP client, Codex asks its app-server through `mcpServer/tool/call`.
 */
export function reportMcp<E, R>(
  emit: (event: RuntimeEvent) => void,
  call: {
    readonly id: string;
    readonly server: string;
    readonly name: string;
    readonly arguments: JsonValue;
    readonly scope?: Attribution;
  },
  effect: Effect.Effect<JsonValue, E, R>,
): Effect.Effect<JsonValue, E, R> {
  const report = (output: JsonValue | null, error: string | null, success: boolean) =>
    Effect.sync(() =>
      emit({
        ...call.scope,
        type: "mcp",
        id: call.id,
        name: call.name,
        server: call.server,
        arguments: call.arguments,
        output,
        error,
        success,
      }),
    );
  // `error` is the transport's: it says the call itself did not answer. A tool that
  // answered with `isError` reported its own failure in `output`, which is what the
  // model and the client's `mcp_call` item must read, so only `success` turns false.
  // A cause, not a failure: a call the job's abort or its scope interrupted is still
  // a call the transcript should show as not having answered.
  return effect.pipe(
    Effect.tapErrorCause(() => report(null, "MCP request failed", false)),
    Effect.tap((output) => report(output, null, succeeded(output))),
  );
}

/** The server's configuration or catalog cannot be used; the message says why. */
export class McpCatalogInvalid extends Data.TaggedError("McpCatalogInvalid")<{
  readonly message: string;
}> {}
/** The model named a remote tool this execution does not provide. */
export class McpToolUnknown extends Data.TaggedError("McpToolUnknown")<{ readonly name: string }> {
  override get message(): string {
    return "Unknown MCP tool";
  }
}
/** The tool's arguments do not match its declared input schema. */
export class McpInputInvalid extends Data.TaggedError("McpInputInvalid")<{
  readonly message: string;
}> {}
/** The server did not answer within the operation's bound. */
export class McpTimeout extends Data.TaggedError("McpTimeout")<{
  readonly server: string;
  readonly operation: string;
}> {
  override get message(): string {
    return `MCP ${this.operation} timed out: ${this.server}`;
  }
}
/** The server or the transport rejected a tool call; the native model reads the reason. */
export class McpRequestFailed extends Data.TaggedError("McpRequestFailed")<{
  readonly server: string;
  readonly operation: string;
  readonly cause: unknown;
}> {
  override get message(): string {
    return `MCP ${this.operation} failed: ${reason(this.cause)}`;
  }
}
export type McpError =
  | McpCatalogInvalid
  | McpToolUnknown
  | McpInputInvalid
  | McpTimeout
  | McpRequestFailed
  | ServiceError;

interface RemoteTool {
  definition: Tool;
  codeName: string;
  server: string;
  name: string;
  client: Client;
}

/**
 * MCP clients for the execution's configured servers. Every connection is a resource
 * of the Scope `open` runs in, so closing that Scope closes the clients. A server
 * that fails to connect or to list its tools is closed at once and its tools are
 * withdrawn; a required one fails `open`.
 */
export class RemoteTools {
  readonly tools: RemoteTool[] = [];
  constructor(
    private readonly signal: AbortSignal,
    private readonly emit: (event: RuntimeEvent) => void,
  ) {}
  /** The job's abort ends a request before the fiber's own interruption reaches it. */
  private signals(signal: AbortSignal): AbortSignal {
    return AbortSignal.any([this.signal, signal]);
  }
  open(execution: Execution): Effect.Effect<void, McpError, Scope.Scope> {
    return Effect.forEach(
      (execution.agent.tools ?? []).filter((tool): tool is McpServer => tool.type === "mcp"),
      (server) => this.connect(server, execution.deadline),
      { discard: true },
    );
  }
  /**
   * Each client lives in a child Scope of the job's. Its close is registered before
   * the connect, and the connect stays interruptible (`acquireRelease` would not be),
   * so a bounded or interrupted connect still releases the transport.
   */
  private connect(server: McpServer, deadline: number): Effect.Effect<void, McpError, Scope.Scope> {
    return Effect.gen(this, function* () {
      const transport = server.transport;
      if (transport.type !== "http" || server.connection_origin === "environment")
        return yield* new McpCatalogInvalid({
          message: "MCP must use the assigned environment/service bridge",
        });
      const client = new Client({ name: "cf-native-tools", version: "1" });
      const owned = yield* Scope.fork(yield* Effect.scope, ExecutionStrategy.sequential);
      const outcome = yield* Effect.gen(this, function* () {
        yield* Effect.acquireRelease(Effect.succeed(client), (connected) =>
          io("mcp.close", () => connected.close()).pipe(Effect.ignore),
        );
        yield* io("mcp.connect", (signal) =>
          client.connect(
            new StreamableHTTPClientTransport(new URL(transport.server_url), {
              requestInit: {
                headers: {
                  ...transport.headers,
                  ...(transport.authorization ? { authorization: transport.authorization } : {}),
                },
                signal: this.signal,
              },
            }),
            { signal: this.signals(signal) },
          ),
        ).pipe(
          Effect.timeoutFail({
            duration: Duration.millis(Math.max(1_000, Math.min(30_000, deadline - Date.now()))),
            onTimeout: () => new McpTimeout({ server: server.server_label, operation: "connect" }),
          }),
        );
        yield* this.list(server, client);
      }).pipe(Scope.extend(owned), Effect.exit);
      if (Exit.isSuccess(outcome)) return;
      // A failed server is released now; a connected one when the job's Scope closes.
      yield* Scope.close(owned, outcome);
      for (let i = this.tools.length - 1; i >= 0; i--)
        if (this.tools[i]?.client === client) this.tools.splice(i, 1);
      if (server.required || this.signal.aborted) return yield* outcome;
    });
  }
  private list(
    server: McpServer,
    client: Client,
  ): Effect.Effect<void, McpCatalogInvalid | ServiceError> {
    return paginate(
      (cursor) =>
        Effect.gen(this, function* () {
          const page = yield* io("mcp.listTools", (signal) =>
            client.listTools({ cursor }, { signal: this.signals(signal) }),
          );
          for (const tool of page.tools) {
            if (server.allowed_tools && !server.allowed_tools.includes(tool.name)) continue;
            if (
              this.tools.length >= 1000 ||
              this.tools.some(
                (entry) => entry.server === server.server_label && entry.name === tool.name,
              )
            )
              return yield* new McpCatalogInvalid({ message: "Invalid MCP tool catalog" });
            const name = `remote_${this.tools.length}__${tool.name.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 40)}`;
            this.tools.push({
              definition: {
                ...tool,
                name,
                description: `${server.server_label}/${tool.name}: ${tool.description ?? ""}`,
              },
              codeName: `mcp__${server.server_label}__${tool.name}`,
              server: server.server_label,
              name: tool.name,
              client,
            });
          }
          return page.nextCursor;
        }),
      () => new McpCatalogInvalid({ message: "MCP pagination did not advance" }),
    );
  }
  /**
   * Call a remote tool by its public or code name. The call is bounded by
   * `CALL_TIMEOUT`, the job's abort and the calling fiber's interruption; every
   * outcome is reported as an `mcp` event before the result or failure is returned.
   */
  call(name: string, input: unknown, scope?: ToolScope): Effect.Effect<JsonValue, McpError> {
    return Effect.gen(this, function* () {
      const tool = this.tools.find(
        (entry) => entry.definition.name === name || entry.codeName === name,
      );
      if (!tool) return yield* new McpToolUnknown({ name });
      const args = yield* Effect.try({
        try: () =>
          z
            .record(z.string(), z.json())
            .parse(
              z
                .fromJSONSchema(z.record(z.string(), z.json()).parse(tool.definition.inputSchema))
                .parse(input ?? {}),
            ),
        catch: (cause) => new McpInputInvalid({ message: reason(cause) }),
      });
      return yield* reportMcp(
        (event) => this.emit(event),
        { id: randomId("mcp"), server: tool.server, name: tool.name, arguments: args, scope },
        io("mcp.call", (signal) =>
          tool.client.callTool({ name: tool.name, arguments: args }, undefined, {
            signal: this.signals(signal),
            timeout: Duration.toMillis(CALL_TIMEOUT) * 2,
          }),
        ).pipe(
          Effect.timeoutFail({
            duration: CALL_TIMEOUT,
            onTimeout: () => new McpTimeout({ server: tool.server, operation: tool.name }),
          }),
          Effect.mapError((error) =>
            error instanceof OperationError
              ? new McpRequestFailed({
                  server: tool.server,
                  operation: tool.name,
                  cause: error.cause,
                })
              : error,
          ),
          Effect.flatMap((raw) => attempt("mcp.result", () => z.json().parse(raw))),
        ),
      );
    });
  }
}
