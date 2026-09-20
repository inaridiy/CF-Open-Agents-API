import { readFileSync } from "node:fs";

/**
 * The `demo` template: a Hono + hono/jsx app that creates a session from a prompt, polls
 * the transcript and returns the artifacts as a zip. The files ship with the package under
 * `templates/demo/`; `examples/demo` in the repository is the same app and the CLI tests
 * compare the two byte for byte. The composition (`src/agents.ts`) is rendered separately.
 */
const DEMO_TEMPLATE_URL = new URL("../../templates/demo/", import.meta.url);

/** Project path → template file. */
export const DEMO_FILES: Readonly<Record<string, string>> = {
  "src/index.tsx": "index.tsx",
  "src/ui.tsx": "ui.tsx",
  "README.md": "README.md",
};

export function demoFile(projectPath: string): string {
  const name = DEMO_FILES[projectPath];
  if (!name) throw new Error(`${projectPath} is not a demo template file`);
  return readFileSync(new URL(name, DEMO_TEMPLATE_URL), "utf8");
}
