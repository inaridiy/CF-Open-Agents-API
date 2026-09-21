import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, it } from "vitest";

import { runInit, versions, workerNameFrom } from "../src/index.js";
import {
  initOptions,
  type Manifest,
  read,
  readJson,
  repoRoot,
  snapshot,
  withEmptyDirectory,
} from "./helpers.js";

const example = (project: "worker" | "demo", file: string) =>
  readFileSync(join(repoRoot, "examples", project, file), "utf8");
const cli = "node packages/create-cf-open-agents-api/dist/cli.js init --yes --force --no-rootless";
/**
 * `examples/*` are what the repository deploys and what the documentation links to, so they
 * are tracked files rather than generated ones. These messages say how to bring one back in
 * line after a change to the renderer or the demo app.
 */
const regenerate = (file: string, command: string, copy: string) =>
  `${file} is generated; regenerate it with:\n  ${cli} ${command}\n  cp ${copy}`;
const DEMO_COPY =
  "the demo template is copied from examples/demo by the CLI package's build; run pnpm build";
/** The examples live inside the workspace; only their paths differ from a generated project. */
const normalize = (text: string) =>
  text
    .replace(
      "../../node_modules/wrangler/config-schema.json",
      "node_modules/wrangler/config-schema.json",
    )
    .replaceAll('"../../docker/', '".cf-open-agents-api/docker/')
    .replaceAll('"../.."', '".cf-open-agents-api"');
const asExample = { name: "cf-open-agents-api", workersAi: true, template: "minimal" } as const;
const asDemo = { name: "cf-open-agents-api-demo", workersAi: true, template: "demo" } as const;

it("a minimal standalone project is the workspace example, generated", async () => {
  await withEmptyDirectory(async (dir) => {
    const { plan, project } = await runInit(initOptions(dir, asExample));
    expect(project.mode).toBe("standalone");
    expect(plan.created).toEqual([
      "package.json",
      "tsconfig.json",
      "wrangler.jsonc",
      ".gitignore",
      "src/index.ts",
      ".cf-open-agents-api/composition.json",
      ".dev.vars",
      ".dev.vars.example",
    ]);
    expect(plan.updated).toEqual([]);
    expect(
      read(dir, "src/index.ts"),
      regenerate(
        "examples/worker/src/index.ts",
        "--template minimal --name cf-open-agents-api --workers-ai /tmp/worker",
        "/tmp/worker/src/index.ts examples/worker/src/index.ts",
      ),
    ).toBe(example("worker", "src/index.ts"));
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
    const again = await runInit(initOptions(dir, asExample));
    expect(again.plan.created).toEqual([]);
    expect(again.plan.updated).toEqual([]);
    expect(snapshot(dir)).toEqual(before);
  });
});

it("the demo template is examples/demo, generated, and is the default for a new project", async () => {
  await withEmptyDirectory(async (dir) => {
    const { plan, answers, agentsPath } = await runInit(initOptions(dir, asDemo));
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
      ".cf-open-agents-api/composition.json",
      ".dev.vars",
      ".dev.vars.example",
    ]);
    expect(plan.updated).toEqual([]);
    expect(agentsPath).toBe(join(dir, "src/agents.ts"));
    for (const file of ["src/index.tsx", "src/ui.tsx", "src/agents.ts", "README.md"])
      expect(
        read(dir, file),
        file === "src/agents.ts"
          ? regenerate(
              "examples/demo/src/agents.ts",
              "--template demo --name cf-open-agents-api-demo --workers-ai /tmp/demo",
              "/tmp/demo/src/agents.ts examples/demo/src/agents.ts",
            )
          : `${file}: ${DEMO_COPY}`,
      ).toBe(example("demo", file));
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
    const again = await runInit(initOptions(dir, asDemo));
    expect(again.plan.created).toEqual([]);
    expect(again.plan.updated).toEqual([]);
    expect(snapshot(dir)).toEqual(before);
    // The defaults pick the demo.
    await withEmptyDirectory(async (other) => {
      const defaults = await runInit(initOptions(other));
      expect(defaults.answers.template).toBe("demo");
      expect(defaults.plan.created).toContain("src/ui.tsx");
    });
  });
});

it("a minimal project stays off workers.dev and is named after its directory", async () => {
  await withEmptyDirectory(async (dir) => {
    await runInit(initOptions(dir, { template: "minimal" }));
    expect(read(dir, "wrangler.jsonc")).toMatch(/"workers_dev": false/);
    expect(read(dir, "wrangler.jsonc")).toContain(`"name": "${workerNameFrom(dir)}"`);
  });
});

it("a dry run in an empty directory writes nothing", async () => {
  await withEmptyDirectory(async (dir) => {
    const { plan } = await runInit(initOptions(dir, { dryRun: true }));
    expect(plan.created).toContain("wrangler.jsonc");
    expect(plan.created).toContain("src/index.tsx");
    expect(plan.created).toContain("src/agents.ts");
    expect([...snapshot(dir).keys()]).toEqual([]);
  });
});

it("an existing tsconfig gains the hono/jsx options the demo needs and keeps the rest", async () => {
  await withEmptyDirectory(async (dir) => {
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
    const { plan } = await runInit(initOptions(dir, asDemo));
    expect(plan.updated).toEqual(["tsconfig.json"]);
    expect(plan.notes.join("\n")).toMatch(/jsx: "react-jsx" and jsxImportSource: "hono\/jsx"/);
    const text = read(dir, "tsconfig.json");
    expect(text).toContain("// strict by choice");
    expect(text).toContain('"target": "ES2022"');
    expect(text).toMatch(/"jsx": "react-jsx",\n\s+"jsxImportSource": "hono\/jsx"/);
    const again = await runInit(initOptions(dir, asDemo));
    expect(again.plan.updated).toEqual([]);
    expect(again.plan.skipped).toContain("tsconfig.json");
    // The minimal template leaves an existing tsconfig alone.
    await withEmptyDirectory(async (minimal) => {
      writeFileSync(join(minimal, "tsconfig.json"), '{ "compilerOptions": {} }\n');
      const kept = await runInit(initOptions(minimal, { template: "minimal" }));
      expect(kept.plan.skipped).toContain("tsconfig.json");
      expect(read(minimal, "tsconfig.json")).toBe('{ "compilerOptions": {} }\n');
    });
  });
});
