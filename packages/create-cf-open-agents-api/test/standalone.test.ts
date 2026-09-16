import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, it } from "vitest";

import { type InitOptions, runInit, workerNameFrom } from "../dist/index.js";
import {
  cleanup,
  emptyDirectory,
  type Manifest,
  offline,
  read,
  readJson,
  repoRoot,
  silent,
  snapshot,
} from "./helpers.js";

const example = (file: string) => readFileSync(join(repoRoot, "examples", "worker", file), "utf8");
/** examples/worker lives inside the workspace; only its paths and date differ from a generated project. */
const normalize = (text: string) =>
  text
    .replace(
      "../../node_modules/wrangler/config-schema.json",
      "node_modules/wrangler/config-schema.json",
    )
    .replaceAll('"../../docker/', '".cf-open-agents-api/docker/')
    .replaceAll('"../.."', '".cf-open-agents-api"')
    .replace(/"compatibility_date": "[0-9-]+"/, '"compatibility_date": "X"');
const options = (dir: string, extra: Partial<InitOptions> = {}): InitOptions => ({
  dir,
  yes: true,
  force: false,
  dryRun: false,
  env: offline,
  reporter: silent(),
  ...extra,
});
const asExample = { name: "cf-open-agents-api", workersAi: true, today: "2026-09-12" };

it("a standalone project is the workspace example, generated", async () => {
  const dir = emptyDirectory();
  try {
    const { plan, project } = await runInit(options(dir, asExample));
    expect(project.mode).toBe("standalone");
    expect(plan.created).toEqual([
      "package.json",
      "tsconfig.json",
      "wrangler.jsonc",
      ".gitignore",
      "src/index.ts",
      ".dev.vars",
      ".dev.vars.example",
    ]);
    expect(plan.updated).toEqual([]);
    expect(read(dir, "src/index.ts")).toBe(example("src/index.ts"));
    expect(normalize(read(dir, "wrangler.jsonc"))).toBe(normalize(example("wrangler.jsonc")));
    expect(read(dir, ".dev.vars.example")).toBe(example(".dev.vars.example"));
    const manifest = readJson<Manifest>(dir, "package.json");
    expect(manifest.scripts.dev).toBe("wrangler dev");
    expect(manifest.scripts.postinstall).toBe("create-cf-open-agents-api vendor");
    expect(manifest.devDependencies.wrangler).toBeDefined();
    expect(read(dir, ".gitignore")).toMatch(
      /\.wrangler\/\n[\s\S]*\.cf-open-agents-api\/\n\.dev\.vars\n$/,
    );
    const before = snapshot(dir);
    const again = await runInit(options(dir, asExample));
    expect(again.plan.created).toEqual([]);
    expect(again.plan.updated).toEqual([]);
    expect(snapshot(dir)).toEqual(before);
  } finally {
    cleanup(dir);
  }
});

it("a public standalone project opts into workers.dev and is named after its directory", async () => {
  const dir = emptyDirectory();
  try {
    await runInit(options(dir, { publicRoute: true }));
    expect(read(dir, "wrangler.jsonc")).toMatch(/"workers_dev": true/);
    expect(read(dir, "wrangler.jsonc")).toContain(`"name": "${workerNameFrom(dir)}"`);
  } finally {
    cleanup(dir);
  }
});

it("a dry run in an empty directory writes nothing", async () => {
  const dir = emptyDirectory();
  try {
    const { plan } = await runInit(options(dir, { dryRun: true }));
    expect(plan.created).toContain("wrangler.jsonc");
    expect(plan.created).toContain("src/index.ts");
    expect([...snapshot(dir).keys()]).toEqual([]);
  } finally {
    cleanup(dir);
  }
});
