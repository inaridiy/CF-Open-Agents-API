import { CONNECTION_FAILURE } from "../transport-failure.js";

/** The Worker-side hosts a harness container reaches through the Container's outbound handler. */
const WORKER_HOSTS = /\b(?:model|sandbox|mcp|delegate)\.internal\b/i;
export const WORKER_UNREACHABLE_HINT =
  "The harness container could not reach the Worker (model.internal / sandbox.internal). With rootless Docker, `wrangler dev` must run inside rootlesskit's network namespace: use the `dev:rootless` script that `create-cf-open-agents-api init` adds, see docs/known-issues.md.";
/**
 * A hint for the harness diagnostics log when a native runtime reports that it could
 * not connect to one of the Worker's internal hosts, the signature of a local
 * emulation whose containers cannot route back to workerd.
 */
export function diagnosticsHint(lines: readonly string[]): string | undefined {
  return lines.some((line) => WORKER_HOSTS.test(line) && CONNECTION_FAILURE.test(line))
    ? WORKER_UNREACHABLE_HINT
    : undefined;
}
