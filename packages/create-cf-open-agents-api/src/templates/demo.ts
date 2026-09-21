/**
 * The `demo` template: a Hono + hono/jsx app that creates a session from a prompt, streams
 * the transcript to the page and returns the artifacts as a zip. The files ship with the
 * package under `templates/demo/`, copied from `examples/demo` by the build; the CLI tests
 * compare a generated project with the example byte for byte, which is what proves the copy
 * ran. The composition (`src/agents.ts`) is rendered separately.
 */

/** Project path → the name of the file under `templates/demo/`. */
export const DEMO_FILES: Readonly<Record<string, string>> = {
  "src/index.tsx": "index.tsx",
  "src/ui.tsx": "ui.tsx",
  "README.md": "README.md",
};
