import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, it } from "vitest";

import { type InitOptions, runInit, versions, workerNameFrom } from "../src/index.js";
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

const example = (project: "worker" | "demo", file: string) =>
  readFileSync(join(repoRoot, "examples", project, file), "utf8");
/** The examples live inside the workspace; only their paths differ from a generated project. */
const normalize = (text: string) =>
  text
    .replace(
      "../../node_modules/wrangler/config-schema.json",
      "node_modules/wrangler/config-schema.json",
    )
    .replaceAll('"../../docker/', '".cf-open-agents-api/docker/')
    .replaceAll('"../.."', '".cf-open-agents-api"');
const options = (dir: string, extra: Partial<InitOptions> = {}): InitOptions => ({
  dir,
  yes: true,
  force: false,
  dryRun: false,
  env: offline,
  reporter: silent(),
  rootless: false,
  ...extra,
});
const asExample = { name: "cf-open-agents-api", workersAi: true, template: "minimal" } as const;
const asDemo = { name: "cf-open-agents-api-demo", workersAi: true, template: "demo" } as const;

it("a minimal standalone project is the workspace example, generated", async () => {
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
    expect(read(dir, "src/index.ts")).toBe(example("worker", "src/index.ts"));
    expect(normalize(read(dir, "wrangler.jsonc"))).toBe(
      normalize(example("worker", "wrangler.jsonc")),
    );
    expect(read(dir, "wrangler.jsonc")).toContain(
      `"compatibility_date": "${versions.COMPATIBILITY_DATE}"`,
    );
    expect(read(dir, "wrangler.jsonc")).toMatch(/"workers_dev": false/);
    expect(read(dir, ".dev.vars.example")).toBe(example("worker", ".dev.vars.example"));
    const manifest = readJson<Manifest>(dir, "package.json");
    expect(manifest.scripts.dev).toBe("wrangler dev");
    expect(manifest.scripts.types).toBe("wrangler types env.d.ts");
    expect(manifest.scripts.postinstall).toBe("create-cf-open-agents-api vendor");
    expect(manifest.scripts["dev:rootless"]).toBeUndefined();
    expect(manifest.devDependencies.wrangler).toBeDefined();
    expect(manifest.dependencies.hono).toBeUndefined();
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

it("the demo template is examples/demo, generated, and is the default for a new project", async () => {
  const dir = emptyDirectory();
  try {
    const { plan, answers, agentsPath } = await runInit(options(dir, asDemo));
    expect(answers.template).toBe("demo");
    expect(plan.created).toEqual([
      "package.json",
      "tsconfig.json",
      "wrangler.jsonc",
      ".gitignore",
      "src/index.tsx",
      "src/ui.tsx",
      "README.md",
      "src/agents.ts",
      ".dev.vars",
      ".dev.vars.example",
    ]);
    expect(plan.updated).toEqual([]);
    expect(agentsPath).toBe(join(dir, "src/agents.ts"));
    for (const file of ["src/index.tsx", "src/ui.tsx", "src/agents.ts", "README.md"])
      expect(read(dir, file), file).toBe(example("demo", file));
    expect(normalize(read(dir, "wrangler.jsonc"))).toBe(
      normalize(example("demo", "wrangler.jsonc")),
    );
    expect(read(dir, "wrangler.jsonc")).toMatch(/"main": "src\/index.tsx"/);
    expect(read(dir, "wrangler.jsonc")).toMatch(/"workers_dev": true/);
    expect(read(dir, "wrangler.jsonc")).toMatch(
      /"binding": "AGENTS",\n\s+"service": "cf-open-agents-api-demo",\n\s+"entrypoint": "Agents"/,
    );
    expect(read(dir, "wrangler.jsonc")).toMatch(
      /"ai": \{\n\s+"binding": "AI",\n\s+"remote": true\n\s+\}/,
    );
    expect(read(dir, "src/agents.ts")).not.toMatch(/export default/);
    expect(read(dir, ".dev.vars.example")).toBe(example("demo", ".dev.vars.example"));
    const manifest = readJson<Manifest>(dir, "package.json");
    expect(manifest.dependencies.hono).toBe(versions.DEMO_VERSIONS.hono);
    expect(manifest.dependencies.fflate).toBe(versions.DEMO_VERSIONS.fflate);
    expect(manifest.dependencies.openai).toBe(versions.PEER_VERSIONS.openai);
    const tsconfig = readJson<{ compilerOptions: Record<string, string> }>(dir, "tsconfig.json");
    expect(tsconfig.compilerOptions.jsx).toBe("react-jsx");
    expect(tsconfig.compilerOptions.jsxImportSource).toBe("hono/jsx");
    const before = snapshot(dir);
    const again = await runInit(options(dir, asDemo));
    expect(again.plan.created).toEqual([]);
    expect(again.plan.updated).toEqual([]);
    expect(snapshot(dir)).toEqual(before);
    // The defaults pick the demo.
    const other = emptyDirectory();
    try {
      const defaults = await runInit(options(other));
      expect(defaults.answers.template).toBe("demo");
      expect(defaults.plan.created).toContain("src/ui.tsx");
    } finally {
      cleanup(other);
    }
  } finally {
    cleanup(dir);
  }
});

it("a minimal project stays off workers.dev and is named after its directory", async () => {
  const dir = emptyDirectory();
  try {
    await runInit(options(dir, { template: "minimal" }));
    expect(read(dir, "wrangler.jsonc")).toMatch(/"workers_dev": false/);
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
    expect(plan.created).toContain("src/index.tsx");
    expect(plan.created).toContain("src/agents.ts");
    expect([...snapshot(dir).keys()]).toEqual([]);
  } finally {
    cleanup(dir);
  }
});

it("an existing tsconfig gains the hono/jsx options the demo needs and keeps the rest", async () => {
  const dir = emptyDirectory();
  try {
    writeFileSync(
      join(dir, "tsconfig.json"),
      [
        "{",
        "  // strict by choice",
        '  "compilerOptions": {',
        '    "target": "ES2022",',
        '    "strict": true,',
        '    "types": ["@cloudflare/workers-types"]',
        "  },",
        '  "include": ["src"]',
        "}",
        "",
      ].join("\n"),
    );
    const { plan } = await runInit(options(dir, asDemo));
    expect(plan.updated).toEqual(["tsconfig.json"]);
    expect(plan.notes.join("\n")).toMatch(/jsx: "react-jsx" and jsxImportSource: "hono\/jsx"/);
    const text = read(dir, "tsconfig.json");
    expect(text).toContain("// strict by choice");
    expect(text).toContain('"target": "ES2022"');
    expect(text).toMatch(/"jsx": "react-jsx",\n\s+"jsxImportSource": "hono\/jsx"/);
    const again = await runInit(options(dir, asDemo));
    expect(again.plan.updated).toEqual([]);
    expect(again.plan.skipped).toContain("tsconfig.json");
    // The minimal template leaves an existing tsconfig alone.
    const minimal = emptyDirectory();
    try {
      writeFileSync(join(minimal, "tsconfig.json"), '{ "compilerOptions": {} }\n');
      const kept = await runInit(options(minimal, { template: "minimal" }));
      expect(kept.plan.skipped).toContain("tsconfig.json");
      expect(read(minimal, "tsconfig.json")).toBe('{ "compilerOptions": {} }\n');
    } finally {
      cleanup(minimal);
    }
  } finally {
    cleanup(dir);
  }
});
