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

import type { ToolScope } from "./job.js";

type McpServer = Extract<NonNullable<Execution["agent"]["tools"]>[number], { type: "mcp" }>;
/** Bound for one remote tool call; the SDK's own request timer sits behind it as a backstop. */
const CALL_TIMEOUT = Duration.seconds(120);
const reason = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

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
    return Effect.gen(this, function* () {
      let cursor: string | undefined;
      const seen = new Set<string>();
      do {
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
        cursor = page.nextCursor;
        if (cursor && seen.has(cursor))
          return yield* new McpCatalogInvalid({ message: "MCP pagination did not advance" });
        if (cursor) seen.add(cursor);
      } while (cursor);
    });
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
      const id = `mcp_${crypto.randomUUID().replaceAll("-", "")}`;
      const report = (output: JsonValue | null, success: boolean) =>
        Effect.sync(() =>
          this.emit({
            type: "mcp",
            id,
            name: tool.name,
            server: tool.server,
            arguments: args,
            output,
            error: output === null ? "MCP request failed" : null,
            success,
            ...scope,
          }),
        );
      const result = yield* io("mcp.call", (signal) =>
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
        Effect.tapErrorCause(() => report(null, false)),
      );
      yield* report(
        result,
        !(result && typeof result === "object" && "isError" in result && result.isError),
      );
      return result;
    });
  }
}
