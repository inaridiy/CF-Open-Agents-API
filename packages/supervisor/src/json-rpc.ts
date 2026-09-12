import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { z } from "zod";

const envelope = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z.object({ message: z.string() }).optional(),
});
export type RpcMessage = z.infer<typeof envelope>;

/** Codex app-server's documented newline-delimited stdio transport. */
export class AppServer {
  private readonly child: ChildProcessWithoutNullStreams;
  private nextId = 0;
  private readonly pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private closed = false;
  constructor(options: {
    binary: string;
    directory: string;
    home: string;
    onMessage: (message: RpcMessage) => void;
    onExit: () => void;
    onDiagnostic: (line: string) => void;
  }) {
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
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      let message: RpcMessage;
      try {
        message = envelope.parse(JSON.parse(line));
      } catch {
        this.fail(new Error("Malformed app-server message"));
        return;
      }
      if (typeof message.id === "number" && !message.method) {
        const request = this.pending.get(message.id);
        if (!request) return;
        this.pending.delete(message.id);
        clearTimeout(request.timer);
        if (message.error) request.reject(new Error(message.error.message));
        else request.resolve(message.result);
      } else options.onMessage(message);
    });
    createInterface({ input: this.child.stderr }).on("line", options.onDiagnostic);
    this.child.on("error", (error) => this.fail(error));
    this.child.on("exit", () => {
      this.closed = true;
      this.fail(new Error("App-server exited"));
      options.onExit();
    });
  }
  request(method: string, params: unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("App-server is closed"));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`App-server request timed out: ${method}`));
      }, 60_000);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ id, method, params });
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
  private write(value: unknown): void {
    this.child.stdin.write(`${JSON.stringify(value)}\n`);
  }
  private fail(error: Error): void {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    this.pending.clear();
  }
  async stop(): Promise<void> {
    if (this.closed) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => this.child.kill("SIGKILL"), 3_000);
      this.child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      this.child.kill("SIGTERM");
    });
  }
}
