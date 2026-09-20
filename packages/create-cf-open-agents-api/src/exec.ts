import { execFileSync } from "node:child_process";

export interface RunOptions {
  cwd?: string;
  input?: string;
  /** Kills the command after this long; the result is then `{ ok: false, timedOut: true }`. */
  timeoutMs?: number;
}
export interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}
/** Runs a command to completion; a failure is a result, not an exception. */
export type Runner = (command: string, args: readonly string[], options?: RunOptions) => RunResult;

export const run: Runner = (command, args, options = {}) => {
  try {
    const stdout = execFileSync(command, [...args], {
      cwd: options.cwd,
      input: options.input,
      timeout: options.timeoutMs,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { ok: true, stdout, stderr: "" };
  } catch (error) {
    const failure = error as { code?: string; stdout?: string; stderr?: string };
    if (failure.code === "ETIMEDOUT")
      return {
        ok: false,
        stdout: failure.stdout ?? "",
        stderr: `${command} ${args.join(" ")} timed out after ${options.timeoutMs ?? 0} ms`,
        timedOut: true,
      };
    return { ok: false, stdout: failure.stdout ?? "", stderr: failure.stderr ?? String(error) };
  }
};

export type PackageManager = "pnpm" | "npm" | "yarn" | "bun";

/** The `<pm> exec`-style prefix that runs a project-local binary such as wrangler. */
export function packageManagerExec(manager: PackageManager): readonly string[] {
  switch (manager) {
    case "pnpm":
      return ["pnpm", "exec"];
    case "yarn":
      return ["yarn"];
    case "bun":
      return ["bunx"];
    default:
      return ["npx"];
  }
}

export function installCommand(manager: PackageManager): string {
  return `${manager} install`;
}
