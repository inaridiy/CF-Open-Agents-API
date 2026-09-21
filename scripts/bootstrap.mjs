import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const EXAMPLES = ["worker", "demo", "caller"];

/**
 * Local development variables for the example Workers: each one's own
 * `.dev.vars.example` with one random API token substituted for its `API_TOKEN`
 * line, so the templates stay the only description of what a Worker needs.
 * Existing files are kept unless `--force`.
 * @param {string} root
 * @param {{ force?: boolean }} [options]
 * @returns {{ file: string, status: "created" | "skipped" }[]}
 */
export function bootstrap(root, options = {}) {
  const token = `${randomUUID()}${randomUUID()}`.replaceAll("-", "");
  // Every template is read and checked before the first file is written.
  const templates = EXAMPLES.map((example) => {
    const file = `examples/${example}/.dev.vars`;
    const template = readFileSync(resolve(root, `${file}.example`), "utf8");
    if (!/^API_TOKEN=.*$/m.test(template)) throw new Error(`${file}.example has no API_TOKEN line`);
    return { file, template };
  });
  return templates.map(({ file, template }) => {
    const path = resolve(root, file);
    if (existsSync(path) && !options.force)
      return { file, status: /** @type {const} */ ("skipped") };
    writeFileSync(path, template.replace(/^API_TOKEN=.*$/m, `API_TOKEN=${token}`));
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
