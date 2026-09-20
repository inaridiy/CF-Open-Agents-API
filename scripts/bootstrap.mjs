import { randomUUID } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Local development variables for the example Workers: one random API token in
 * every file. Existing files are kept unless `--force`.
 * @param {string} root
 * @param {{ force?: boolean }} [options]
 * @returns {{ file: string, status: "created" | "skipped" }[]}
 */
export function bootstrap(root, options = {}) {
  const token = `${randomUUID()}${randomUUID()}`.replaceAll("-", "");
  const worker = [
    `API_TOKEN=${token}`,
    "# Required for the codex, claude and opencode presets; leave empty to use only `workers`.",
    "OPENAI_API_KEY=",
    "# Store sandbox backups on the local R2 emulator during `wrangler dev`; unset in production.",
    "LOCAL_BACKUPS=true",
    "",
  ].join("\n");
  const files = [
    { file: "examples/worker/.dev.vars", content: worker },
    { file: "examples/demo/.dev.vars", content: worker },
    { file: "examples/caller/.dev.vars", content: `API_TOKEN=${token}\n` },
  ];
  return files.map(({ file, content }) => {
    const path = resolve(root, file);
    if (existsSync(path) && !options.force)
      return { file, status: /** @type {const} */ ("skipped") };
    writeFileSync(path, content);
    return { file, status: /** @type {const} */ ("created") };
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const results = bootstrap(fileURLToPath(new URL("..", import.meta.url)), {
    force: process.argv.includes("--force"),
  });
  for (const { file, status } of results)
    console.log(`${status === "created" ? "✔" : "-"} ${file} ${status}`);
  if (results.some((result) => result.status === "skipped"))
    console.log("Existing files were kept; pass --force to regenerate all with a new token.");
  console.log(
    "Next: pnpm dev:caller (Docker running, wrangler login done), see README.md#first-run.",
  );
}
