/**
 * Commands and file operations on a container through `ctx.container.exec`. Each call is
 * one process; nothing carries over between calls, so every call names its working
 * directory and environment. Only the Durable Object that owns the container runs these.
 */
export type ExecTarget = Pick<Container, "exec">;

export type ExecInput = string | Uint8Array | ReadableStream<Uint8Array>;

/** A failure this cleanup cannot act on. */
const ignore = (): void => {};

export interface ExecOptions {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  /**
   * Ends the command and every process it started (GNU `timeout` on its process group).
   * Absent or 0 means no limit.
   */
  readonly timeoutMs?: number;
  /** Combined bytes of stdout and stderr kept; past it the command is stopped. Default 16 MiB. */
  readonly maxBytes?: number;
  readonly stdin?: ExecInput;
  /** Stops the command and every process it started. */
  readonly signal?: AbortSignal;
}

export interface ExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly truncated: boolean;
}

/** A failed file operation; `code` is the shell's diagnosis (`ENOENT` when the path is missing). */
export class WorkspaceFileError extends Error {
  constructor(
    readonly operation: string,
    readonly path: string,
    readonly code: "ENOENT" | "EFAILED",
    detail: string,
  ) {
    super(`${operation} '${path}': ${detail.trim() || code}`);
    this.name = "WorkspaceFileError";
  }
}

const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
/**
 * File operations end within these bounds: a model can turn any path into a FIFO or a
 * device, and an operation that never returns would hold the object's permits forever.
 */
const FILE_TIMEOUT_MS = 60_000;
const TRANSFER_TIMEOUT_MS = 10 * 60 * 1000;
/** Exit codes of `timeout` when it ended the command (SIGTERM, then SIGKILL after the grace). */
const TIMEOUT_EXITS = new Set([124, 137]);

const stream = (input: ExecInput): ReadableStream<Uint8Array> =>
  typeof input === "string" || input instanceof Uint8Array
    ? new Blob([
        typeof input === "string" ? new TextEncoder().encode(input) : input.slice(),
      ]).stream()
    : input;

/**
 * `argv` under `timeout`, which leads its own process group, so a stop reaches every
 * process the command started. A duration of 0 means no limit.
 */
function bounded(argv: readonly string[], timeoutMs: number | undefined): string[] {
  const seconds =
    timeoutMs === undefined || timeoutMs <= 0 ? 0 : Math.max(1, Math.ceil(timeoutMs / 1000));
  return ["timeout", "--kill-after=5", `${seconds}s`, ...argv];
}

/** Signals the process group `pid` leads; a group that already exited is not an error. */
async function stopGroup(target: ExecTarget, pid: number): Promise<void> {
  // bash's kill takes `--` before a negative process group id; dash's rejects it.
  const kill = await target.exec(
    ["bash", "-c", 'kill -KILL -- "-$1" 2>/dev/null; true', "bash", String(pid)],
    {
      stdout: "ignore",
      stderr: "ignore",
    },
  );
  await kill.exitCode;
}

/**
 * Reads a stream to the end, handing each chunk to `sink` until `budget` says stop.
 * Returns false when the budget ran out (the rest is cancelled, not read).
 */
async function drain(
  readable: ReadableStream<Uint8Array> | null | undefined,
  sink: (chunk: Uint8Array) => boolean,
): Promise<boolean> {
  if (!readable) return true;
  const reader = readable.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return true;
      if (!sink(value)) {
        await reader.cancel().catch(ignore);
        return false;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Runs `argv` and collects its output. A nonzero exit is a result, not an error. Output
 * past `maxBytes`, the timeout and the signal each stop the command's whole process group.
 */
export async function run(
  target: ExecTarget,
  argv: readonly string[],
  options: ExecOptions & { readonly onOutput?: (text: string) => void } = {},
): Promise<ExecResult> {
  options.signal?.throwIfAborted();
  const started = Date.now();
  const process = await target.exec(bounded(argv, options.timeoutMs), {
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.env ? { env: { ...options.env } } : {}),
    ...(options.stdin === undefined ? {} : { stdin: stream(options.stdin) }),
  });
  let exited = false;
  const exitCode = process.exitCode.then((code) => {
    exited = true;
    return code;
  });
  const stop = () => (exited ? Promise.resolve() : stopGroup(target, process.pid));
  const onAbort = () => void stop().catch(ignore);
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const limit = options.maxBytes ?? DEFAULT_MAX_BYTES;
  let bytes = 0;
  let truncated = false;
  const decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() };
  const text = { stdout: "", stderr: "" };
  const collect = (channel: "stdout" | "stderr") => (chunk: Uint8Array) => {
    bytes += chunk.byteLength;
    if (bytes > limit) {
      truncated = true;
      void stop().catch(ignore);
      return false;
    }
    const delta = decoders[channel].decode(chunk, { stream: true });
    text[channel] += delta;
    if (delta) options.onOutput?.(delta);
    return true;
  };
  try {
    await Promise.all([
      drain(process.stdout, collect("stdout")),
      drain(process.stderr, collect("stderr")),
    ]);
    const code = await exitCode;
    for (const channel of ["stdout", "stderr"] as const) {
      const tail = decoders[channel].decode();
      text[channel] += tail;
      if (tail) options.onOutput?.(tail);
    }
    options.signal?.throwIfAborted();
    return {
      exitCode: code,
      stdout: text.stdout,
      stderr: text.stderr,
      timedOut:
        options.timeoutMs !== undefined &&
        options.timeoutMs > 0 &&
        TIMEOUT_EXITS.has(code) &&
        Date.now() - started >= options.timeoutMs,
      truncated,
    };
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    if (!exited) await stop().catch(ignore);
  }
}

/** Starts a long-lived process whose output nobody reads; it outlives the request. */
export async function spawn(
  target: ExecTarget,
  argv: readonly string[],
  options: Pick<ExecOptions, "cwd" | "env"> = {},
): Promise<number> {
  const process = await target.exec([...argv], {
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.env ? { env: { ...options.env } } : {}),
    stdout: "ignore",
    stderr: "ignore",
  });
  return process.pid;
}

const failed = (operation: string, path: string, result: ExecResult): WorkspaceFileError =>
  new WorkspaceFileError(
    operation,
    path,
    /No such file or directory/i.test(result.stderr) ? "ENOENT" : "EFAILED",
    result.stderr,
  );

export async function readText(
  target: ExecTarget,
  path: string,
  maxBytes: number,
): Promise<string> {
  const result = await run(target, ["cat", "--", path], { maxBytes, timeoutMs: FILE_TIMEOUT_MS });
  if (result.truncated) throw new WorkspaceFileError("readFile", path, "EFAILED", "file too large");
  if (result.exitCode !== 0) throw failed("readFile", path, result);
  return result.stdout;
}

/** The file's bytes as a stream; the caller consumes or cancels it. */
export async function readStream(
  target: ExecTarget,
  path: string,
): Promise<ReadableStream<Uint8Array>> {
  const process = await target.exec(bounded(["cat", "--", path], TRANSFER_TIMEOUT_MS), {
    stderr: "ignore",
  });
  if (!process.stdout)
    throw new WorkspaceFileError("readFile", path, "EFAILED", "no output stream");
  return process.stdout;
}

/** Creates or replaces a file, creating its parent directories. */
export async function writeFile(
  target: ExecTarget,
  path: string,
  content: ExecInput,
): Promise<void> {
  const result = await run(
    target,
    ["sh", "-c", 'mkdir -p -- "$(dirname -- "$1")" && cat > "$1"', "sh", path],
    { stdin: content, maxBytes: 64 * 1024, timeoutMs: TRANSFER_TIMEOUT_MS },
  );
  if (result.exitCode !== 0) throw failed("writeFile", path, result);
}

export async function mkdir(target: ExecTarget, path: string): Promise<void> {
  const result = await run(target, ["mkdir", "-p", "--", path], {
    maxBytes: 64 * 1024,
    timeoutMs: FILE_TIMEOUT_MS,
  });
  if (result.exitCode !== 0) throw failed("mkdir", path, result);
}

export async function remove(target: ExecTarget, path: string): Promise<void> {
  const result = await run(target, ["rm", "-rf", "--", path], {
    maxBytes: 64 * 1024,
    timeoutMs: FILE_TIMEOUT_MS,
  });
  if (result.exitCode !== 0) throw failed("remove", path, result);
}

export async function exists(target: ExecTarget, path: string): Promise<boolean> {
  const result = await run(target, ["test", "-e", path], {
    maxBytes: 1024,
    timeoutMs: FILE_TIMEOUT_MS,
  });
  return result.exitCode === 0;
}

/** `find -printf %y` letters. */
const FIND_TYPES: Readonly<Record<string, ListedFile["type"]>> = {
  f: "file",
  d: "directory",
  l: "symlink",
};

export interface ListedFile {
  readonly path: string;
  readonly type: "file" | "directory" | "symlink" | "other";
  readonly size: number;
}

/** Every entry below `directory`, hidden ones included, without following links. */
export async function list(target: ExecTarget, directory: string): Promise<ListedFile[]> {
  // A missing directory is an error; an entry that vanishes during the walk is not.
  const result = await run(
    target,
    [
      "sh",
      "-c",
      '[ -d "$1" ] || { echo "$1: No such file or directory" >&2; exit 2; }; find "$1" -mindepth 1 -printf "%y\\t%s\\t%p\\0" 2>/dev/null; exit 0',
      "sh",
      directory,
    ],
    { maxBytes: 32 * 1024 * 1024, timeoutMs: FILE_TIMEOUT_MS },
  );
  if (result.truncated)
    throw new WorkspaceFileError("list", directory, "EFAILED", "listing too large");
  if (result.exitCode !== 0) throw failed("list", directory, result);
  return result.stdout
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const [kind = "", size = "0", ...rest] = line.split("\t");
      return { path: rest.join("\t"), type: FIND_TYPES[kind] ?? "other", size: Number(size) };
    });
}

/** Whether a process inside the container accepts connections on `port`. */
export async function listening(target: ExecTarget, port: number): Promise<boolean> {
  const result = await run(
    target,
    ["bash", "-c", `exec 3<>/dev/tcp/127.0.0.1/${port} 2>/dev/null && echo up || echo down`],
    { timeoutMs: 10_000, maxBytes: 1024 },
  );
  return result.stdout.includes("up");
}
