import { readFileSync } from "node:fs";

/**
 * A file shipped verbatim with the package under `templates/<directory>/`, rather than
 * rendered: the demo app and the rootless Docker scripts. Read from the package so a
 * `pnpm dlx` run uses the tarball's copy, never the repository's.
 */
export function templateFile(directory: string, name: string): string {
  return readFileSync(new URL(`../../templates/${directory}/${name}`, import.meta.url), "utf8");
}
