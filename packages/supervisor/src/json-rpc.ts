import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { attempt, runPromise, runSync } from "cf-open-agents-api";
import { Deferred, Effect, Ref } from "effect";
import { z } from "zod";
import { once } from "./lifecycle.js";

const envelope = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z.object({ code: z.number().optional(), message: z.string() }).optional(),
});
export type RpcMessage = z.infer<typeof envelope>;

/** The app-server answered a request with a JSON-RPC error: a definite rejection, not a transport failure. */
export class RpcError extends Error {
  constructor(
    readonly code: number | undefined,
    message: string,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

/** Codex app-server's documented newline-delimited stdio transport. */
export class AppServer {
  private readonly child: ChildProcessWithoutNullStreams;
  private nextId = 0;
  private readonly pending = Ref.unsafeMake(new Map<number, Deferred.Deferred<unknown, Error>>());
  private readonly exited = runSync(Deferred.make<void>());
  private closed = false;
  private readonly onDiagnostic: (line: string) => void;
  private readonly stopped = once("app-server.stop", () =>
    runPromise(
      Effect.gen(this, function* () {
        if (this.closed) return;
        this.child.kill("SIGTERM");
        yield* Deferred.await(this.exited).pipe(Effect.timeoutOption("3 seconds"));
        if (!this.closed) {
          this.child.kill("SIGKILL");
          yield* Deferred.await(this.exited);
        }
      }),
    ),
  );
  constructor(options: {
    binary: string;
    directory: string;
    home: string;
    onMessage: (message: RpcMessage) => void;
    onExit: () => void;
    onDiagnostic: (line: string) => void;
  }) {
    this.onDiagnostic = options.onDiagnostic;
    this.child = spawn(options.binary, ["app-server", "--listen", "stdio://"], {
      cwd: options.directory,
      // An explicit child environment keeps host credentials out of Codex.
      env: {
        PATH: process.env.PATH,
        HOME: options.home,
        CODEX_HOME: options.home,
        RUST_LOG: "warn",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    // A broken pipe while writing to a dying process is diagnosed, never thrown at top level.
    this.child.stdin.on("error", (error) => {
      options.onDiagnostic(`app-server stdin: ${error.message}`);
    });
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      let message: RpcMessage;
      try {
        message = envelope.parse(JSON.parse(line));
      } catch {
        // One unparseable line does not invalidate the transport or other requests.
        options.onDiagnostic(`app-server: dropped malformed message: ${line.slice(0, 512)}`);
        return;
      }
      if (typeof message.id === "number" && !message.method) {
        const request = runSync(Ref.get(this.pending)).get(message.id);
        if (!request) return;
        if (message.error)
          runSync(Deferred.fail(request, new RpcError(message.error.code, message.error.message)));
        else runSync(Deferred.succeed(request, message.result));
      } else options.onMessage(message);
    });
    createInterface({ input: this.child.stderr }).on("line", options.onDiagnostic);
    this.child.on("error", (error) => {
      this.closed = true;
      this.fail(error);
      runSync(Deferred.succeed(this.exited, undefined));
    });
    this.child.on("exit", () => {
      this.closed = true;
      this.fail(new Error("App-server exited"));
      runSync(Deferred.succeed(this.exited, undefined));
      options.onExit();
    });
  }
  request(method: string, params: unknown): Promise<unknown> {
    return runPromise(
      Effect.gen(this, function* () {
        if (this.closed) return yield* Effect.fail(new Error("App-server is closed"));
        const id = ++this.nextId;
        return yield* Effect.acquireUseRelease(
          Effect.gen(this, function* () {
            const result = yield* Deferred.make<unknown, Error>();
            yield* Ref.update(this.pending, (pending) => new Map(pending).set(id, result));
            return result;
          }),
          (result) =>
            attempt("app-server.write", () => this.write({ id, method, params })).pipe(
              Effect.zipRight(Deferred.await(result)),
              Effect.timeoutFail({
                duration: "60 seconds",
                onTimeout: () => new Error(`App-server request timed out: ${method}`),
              }),
            ),
          () =>
            Ref.update(this.pending, (pending) => {
              const next = new Map(pending);
              next.delete(id);
              return next;
            }),
        );
      }),
    );
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
  private fail(error: Error): void {
    const pending = runSync(Ref.getAndSet(this.pending, new Map()));
    for (const request of pending.values()) runSync(Deferred.fail(request, error));
  }
  stop(): Promise<void> {
    return runPromise(this.stopped);
  }
}
