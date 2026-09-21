import { join } from "node:path";

import type { Runner, RunResult } from "../exec.js";
import { type Files, keepUnlessForce } from "../fs.js";
import type { StepResult } from "../plan.js";
import { templateFile } from "../templates/files.js";
import { ROOTLESS_FILES } from "../templates/rootless.js";

/** `docker info` hangs when the daemon socket exists but nobody answers; never wait longer. */
export const DOCKER_INFO_TIMEOUT_MS = 5000;

/**
 * One `docker info` call answers both "is an engine reachable" (`ok`) and "is it rootless"
 * (`rootlessEngine`). A timeout is a failed result, so a stalled daemon never blocks `init`.
 */
export function dockerInfo(runner: Runner, cwd?: string): RunResult {
  return runner("docker", ["info", "--format", "{{json .SecurityOptions}}"], {
    cwd,
    timeoutMs: DOCKER_INFO_TIMEOUT_MS,
  });
}

/** Reads the engine's security options; a rootless daemon reports `name=rootless`. */
export function rootlessEngine(info: RunResult): boolean {
  return info.ok && /name=rootless/.test(info.stdout);
}

/**
 * True when the Docker engine this machine talks to runs rootless. Wrangler's local
 * container proxy then cannot route the containers back to workerd, so `wrangler dev`
 * starts but every turn fails; see the rootless Docker row in the known issues.
 */
export function detectRootlessDocker(runner: Runner, platform = process.platform): boolean {
  if (platform !== "linux") return false;
  return rootlessEngine(dockerInfo(runner));
}

/** Writes the two scripts behind `dev:rootless`; an edited script is kept unless `--force`. */
export function ensureRootlessDev(files: Files, force: boolean): StepResult[] {
  return Object.entries(ROOTLESS_FILES).map(([file, name]) => {
    const path = join(files.root, file);
    const content = templateFile("rootless", name);
    return keepUnlessForce(files, path, content, force) ?? files.write(path, content);
  });
}
