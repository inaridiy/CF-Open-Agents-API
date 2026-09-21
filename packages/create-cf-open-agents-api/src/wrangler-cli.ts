import { packageManagerExec, type Runner, type RunResult } from "./exec.js";
import { display } from "./fs.js";
import type { Project } from "./project.js";

/** Runs the project's own wrangler, and prints the same command for a dry run or a hint. */
export interface Wrangler {
  (args: readonly string[], input?: string): RunResult;
  describe(args: readonly string[]): string;
}

/**
 * `<package manager> exec wrangler ...` with the project as the working directory.
 * `setup` names the configuration explicitly because it acts on it; `doctor` only asks
 * wrangler about itself and the account, where a `--config` would be noise.
 */
export function wranglerFor(project: Project, runner: Runner, configured = true): Wrangler {
  const exec = packageManagerExec(project.packageManager);
  // wrangler runs with the project as cwd, so the configuration is named relative to it.
  const config = configured ? ["--config", display(project.root, project.configPath)] : [];
  const call = ((args, input) =>
    runner(exec[0] ?? "npx", [...exec.slice(1), "wrangler", ...args, ...config], {
      cwd: project.root,
      input,
    })) as Wrangler;
  call.describe = (args) => [...exec, "wrangler", ...args, ...config].join(" ");
  return call;
}
