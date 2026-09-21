import { type PackageManager, packageManagerExec } from "../exec.js";

/**
 * The rootless Docker patch: a `dev:rootless` script that runs `wrangler dev` inside
 * rootlesskit's network namespace and bridges the port back to the host. The files ship
 * with the package under `templates/rootless/`. It is a temporary workaround for
 * Wrangler's local container proxy assuming a rootful bridge, to be removed when Wrangler
 * supports rootless engines.
 */

/** Project path → the name of the file under `templates/rootless/`. */
export const ROOTLESS_FILES: Readonly<Record<string, string>> = {
  "scripts/dev-rootless.sh": "dev-rootless.sh",
  "scripts/netns-bridge.mjs": "netns-bridge.mjs",
};
/** The package.json script the patch adds. */
export const ROOTLESS_SCRIPT_NAME = "dev:rootless";
/**
 * `WRANGLER` tells the shell script how to run the project's wrangler (`pnpm exec wrangler`,
 * `npx wrangler`, ...); the script defaults to `npx wrangler` when the variable is unset.
 */
export function rootlessScript(manager: PackageManager): string {
  return `WRANGLER="${packageManagerExec(manager).join(" ")} wrangler" sh scripts/dev-rootless.sh`;
}
