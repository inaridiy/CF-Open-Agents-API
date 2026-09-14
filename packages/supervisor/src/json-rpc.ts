import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface } from "node:readline";

import { Data, Deferred, Effect, MutableRef, Option, Queue, type Scope, Stream } from "effect";
import { z } from "zod";

import { acquireProcess, awaitExit } from "./process.js";

const envelope = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z.object({ code: z.number().optional(), message: z.string() }).optional(),
});
export type RpcMessage = z.infer<typeof envelope>;

/** The app-server answered a request with a JSON-RPC error: a definite rejection, not a transport failure. */
export class RpcError extends Data.TaggedError("RpcError")<{
  readonly code: number | undefined;
  readonly message: string;
}> {}
/** The process is gone or was never usable; nothing sent afterwards can be answered. */
export class TransportClosed extends Data.TaggedError("TransportClosed")<{
  readonly message: string;
}> {}
/** The app-server did not answer within the request budget. */
export class RpcTimeout extends Data.TaggedError("RpcTimeout")<{ readonly method: string }> {
  override get message(): string {
    return `App-server request timed out: ${this.method}`;
  }
}
export type RpcFailure = RpcError | TransportClosed | RpcTimeout;

export interface AppServerOptions {
  binary: string;
  directory: string;
  home: string;
  onDiagnostic: (line: string) => void;
}
const REQUEST_TIMEOUT = "60 seconds";

/**
 * Codex app-server's documented newline-delimited stdio transport, owned by a
 * Scope: closing it terminates the process (SIGTERM, 3 s, SIGKILL), then settles
 * every request still pending. Responses complete per-request Deferreds; everything
 * else arrives on `messages` in order.
 */
export class AppServer {
  /** Notifications and server-initiated requests; ends once the process is gone. */
  readonly messages: Stream.Stream<RpcMessage>;
  /** Completed once the process has exited or failed to spawn. */
  readonly exited: Effect.Effect<void>;
  private nextId = 0;
  private closed = false;
  private readonly pending = new Map<
    number,
    Deferred.Deferred<unknown, RpcError | TransportClosed>
  >();
  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly inbox: Queue.Queue<RpcMessage>,
    private readonly gone: Deferred.Deferred<void>,
    private readonly onDiagnostic: (line: string) => void,
  ) {
    this.messages = Stream.fromQueue(inbox);
    this.exited = Deferred.await(gone);
  }
  static acquire(options: AppServerOptions): Effect.Effect<AppServer, never, Scope.Scope> {
    return Effect.gen(function* () {
      const inbox = yield* Queue.unbounded<RpcMessage>();
      const gone = yield* Deferred.make<void>();
      // Registered before the process so it runs after termination: pending requests
      // learn that the app-server exited, exactly as when it dies on its own.
      const transport = MutableRef.make(Option.none<AppServer>());
      yield* Effect.addFinalizer(() =>
        Option.match(MutableRef.get(transport), {
          onNone: () => Effect.void,
          onSome: (server) => server.close(),
        }),
      );
      const child = yield* acquireProcess(
        () =>
          spawn(options.binary, ["app-server", "--listen", "stdio://"], {
            cwd: options.directory,
            // An explicit child environment keeps host credentials out of Codex.
            env: {
              PATH: process.env.PATH,
              HOME: options.home,
              CODEX_HOME: options.home,
              RUST_LOG: "warn",
            },
            stdio: ["pipe", "pipe", "pipe"],
          }),
        "3 seconds",
      );
      const server = new AppServer(child, inbox, gone, options.onDiagnostic);
      MutableRef.set(transport, Option.some(server));
      // A broken pipe while writing to a dying process is diagnosed, never thrown at top level.
      child.stdin.on("error", (error) => {
        options.onDiagnostic(`app-server stdin: ${error.message}`);
      });
      createInterface({ input: child.stderr }).on("line", options.onDiagnostic);
      yield* Stream.fromAsyncIterable(
        createInterface({ input: child.stdout }),
        (cause) => new TransportClosed({ message: `app-server stdout: ${String(cause)}` }),
      ).pipe(
        Stream.runForEach((line) => Effect.sync(() => server.route(line))),
        Effect.catchAll((error) => Effect.sync(() => options.onDiagnostic(error.message))),
        Effect.forkScoped,
      );
      yield* awaitExit(child).pipe(Effect.zipRight(server.close()), Effect.forkScoped);
      return server;
    });
  }
  private route(line: string): void {
    let message: RpcMessage;
    try {
      message = envelope.parse(JSON.parse(line));
    } catch {
      // One unparseable line does not invalidate the transport or other requests.
      this.onDiagnostic(`app-server: dropped malformed message: ${line.slice(0, 512)}`);
      return;
    }
    if (typeof message.id === "number" && !message.method) {
      const request = this.pending.get(message.id);
      if (!request) return;
      Deferred.unsafeDone(
        request,
        message.error
          ? Effect.fail(new RpcError({ code: message.error.code, message: message.error.message }))
          : Effect.succeed(message.result),
      );
    } else Queue.unsafeOffer(this.inbox, message);
  }
  /** The process is gone: fail what is still pending and end the message stream. */
  private close(): Effect.Effect<void> {
    return Effect.gen(this, function* () {
      if (this.closed) return;
      this.closed = true;
      const failure = Effect.fail(new TransportClosed({ message: "App-server exited" }));
      for (const request of this.pending.values()) Deferred.unsafeDone(request, failure);
      this.pending.clear();
      yield* Queue.shutdown(this.inbox);
      yield* Deferred.complete(this.gone, Effect.void);
    });
  }
  request(method: string, params: unknown): Effect.Effect<unknown, RpcFailure> {
    return Effect.suspend(() => {
      if (this.closed) return new TransportClosed({ message: "App-server is closed" });
      const id = ++this.nextId;
      return Effect.acquireUseRelease(
        Effect.gen(this, function* () {
          const result = yield* Deferred.make<unknown, RpcError | TransportClosed>();
          this.pending.set(id, result);
          return result;
        }),
        (result) =>
          Effect.sync(() => this.write({ id, method, params })).pipe(
            Effect.zipRight(Deferred.await(result)),
            Effect.timeoutFail({
              duration: REQUEST_TIMEOUT,
              onTimeout: () => new RpcTimeout({ method }),
            }),
          ),
        () => Effect.sync(() => this.pending.delete(id)),
      );
    });
  }
  notify(method: string, params?: unknown): void {
    this.write({ method, params });
  }
  respond(id: number | string, result: unknown): void {
    this.write({ id, result });
  }
  reject(id: number | string): void {
    this.write({ id, error: { code: -32601, message: "Unsupported server request" } });
  }
  /** Writes to a closed process are dropped: nothing can consume them. */
  private write(value: unknown): void {
    if (this.closed || this.child.stdin.destroyed || !this.child.stdin.writable) return;
    try {
      this.child.stdin.write(`${JSON.stringify(value)}\n`);
    } catch (error) {
      this.onDiagnostic(`app-server write failed: ${String(error)}`);
    }
  }
}
