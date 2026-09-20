import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, it } from "vitest";

import { CliError, type InitOptions, parseDevVars, runInit, versions } from "../src/index.js";
import {
  cleanup,
  cliPath,
  copyFixture,
  emptyDirectory,
  type Manifest,
  offline,
  read,
  readJson,
  silent,
  snapshot,
} from "./helpers.js";

const base = (dir: string, extra: Partial<InitOptions> = {}): InitOptions => ({
  dir,
  yes: true,
  force: false,
  dryRun: false,
  env: offline,
  reporter: silent(),
  rootless: false,
  token: () => "t".repeat(40),
  ...extra,
});
const conflict = (pattern: RegExp) => (error: unknown) =>
  error instanceof CliError && pattern.test(error.message);

it("retrofit adds the API to an existing Vite Worker project", async () => {
  const dir = copyFixture("vite-project");
  try {
    const { plan, answers } = await runInit(base(dir));
    expect(answers.harnesses).toEqual(["codex", "claude-code", "opencode"]);
    expect(plan.created).toEqual(["src/agents.ts", ".dev.vars.example"]);
    expect(plan.updated).toEqual([
      "wrangler.jsonc",
      "src/index.ts",
      ".dev.vars",
      ".gitignore",
      "package.json",
      "tsconfig.json",
    ]);
    const wrangler = read(dir, "wrangler.jsonc");
    expect(wrangler).toMatch(/\/\/ The app's own Worker/);
    expect(wrangler).toMatch(/"compatibility_flags": \["nodejs_compat", "enable_ctx_exports"\]/);
    expect(wrangler).toMatch(/"new_sqlite_classes": \["Counter"\]/);
    expect(wrangler).toMatch(
      /"tag": "v2",\n\s+"new_sqlite_classes": \["SessionDO", "TenantCatalogDO", "HarnessDO", "SandboxDO"\]/,
    );
    expect(wrangler).toMatch(/"BACKUP_BUCKET_NAME": "my-app-workspaces"/);
    expect(wrangler).toMatch(/"image": ".cf-open-agents-api\/docker\/Harness.Dockerfile"/);
    expect(wrangler).toMatch(
      /"binding": "AGENTS",\n\s+"service": "my-app",\n\s+"entrypoint": "Agents"/,
    );
    expect(wrangler).toMatch(/"binding": "CODE_LOADER"/);
    expect(read(dir, "src/index.ts")).toMatch(
      /export \{ Agents, Models, SessionDO, TenantCatalogDO, HarnessDO, SandboxDO, ContainerProxy \} from "\.\/agents\.js";\n$/,
    );
    expect(read(dir, "src/agents.ts")).toMatch(/defineAgentWorker<Bindings>/);
    expect(read(dir, "src/agents.ts")).not.toMatch(/export default/);
    const devVars = parseDevVars(read(dir, ".dev.vars"));
    expect(devVars.get("API_TOKEN")).toBe("t".repeat(40));
    expect(devVars.get("OPENAI_API_KEY")).toBe("sk-existing");
    expect(devVars.get("LOCAL_BACKUPS")).toBe("true");
    const manifest = readJson<Manifest>(dir, "package.json");
    expect(manifest.dependencies["cf-open-agents-api"]).toBe(versions.CLI_VERSION);
    expect(manifest.dependencies.effect).toBe("3.21.0");
    expect(manifest.scripts.postinstall).toBe("echo hi && create-cf-open-agents-api vendor");
    expect(manifest.devDependencies["create-cf-open-agents-api"]).toBe(versions.CLI_VERSION);
    expect(read(dir, ".gitignore")).toMatch(/\.cf-open-agents-api\/\n\.dev\.vars\n$/);
    expect(readJson<{ exclude: string[] }>(dir, "tsconfig.json").exclude).toEqual([
      ".cf-open-agents-api",
    ]);
    expect(plan.notes.join("\n")).toMatch(/enable_ctx_exports/);
    expect(plan.notes.join("\n")).toMatch(/Named environments \(staging\)/);
    expect(plan.notes.join("\n")).toMatch(/kept existing entries: effect@3\.21\.0/);
  } finally {
    cleanup(dir);
  }
});

it("a second run changes nothing", async () => {
  const dir = copyFixture("vite-project");
  try {
    await runInit(base(dir));
    const before = snapshot(dir);
    const { plan } = await runInit(base(dir));
    expect(plan.created).toEqual([]);
    expect(plan.updated).toEqual([]);
    expect(snapshot(dir)).toEqual(before);
  } finally {
    cleanup(dir);
  }
});

it("a dry run reports the plan and writes nothing", async () => {
  const dir = copyFixture("vite-project");
  try {
    const before = snapshot(dir);
    const { plan } = await runInit(base(dir, { dryRun: true }));
    expect(plan.created).toContain("src/agents.ts");
    expect(plan.updated).toContain("wrangler.jsonc");
    expect(snapshot(dir)).toEqual(before);
  } finally {
    cleanup(dir);
  }
});

it("--force rewrites a diverged composition and gateway binding", async () => {
  const dir = copyFixture("vite-project");
  try {
    await runInit(base(dir));
    writeFileSync(join(dir, "src/agents.ts"), "// edited\n");
    const diverged = read(dir, "wrangler.jsonc").replace(
      '"entrypoint": "Models"',
      '"entrypoint": "Other"',
    );
    writeFileSync(join(dir, "wrangler.jsonc"), diverged);
    await expect(runInit(base(dir))).rejects.toSatisfy(conflict(/MODEL_GATEWAY/));
    const forced = await runInit(base(dir, { force: true }));
    expect(forced.plan.updated).toContain("src/agents.ts");
    expect(read(dir, "wrangler.jsonc")).toMatch(/"entrypoint": "Models"/);
    expect(read(dir, "src/agents.ts")).toMatch(/defineAgentWorker/);
  } finally {
    cleanup(dir);
  }
});

it("an edited composition is kept without --force", async () => {
  const dir = copyFixture("vite-project");
  try {
    await runInit(base(dir));
    writeFileSync(join(dir, "src/agents.ts"), "// edited\n");
    const { plan } = await runInit(base(dir));
    expect(plan.skipped).toContain("src/agents.ts");
    expect(read(dir, "src/agents.ts")).toBe("// edited\n");
    expect(plan.notes.join("\n")).toMatch(/--force rewrites it/);
  } finally {
    cleanup(dir);
  }
});

it.each([
  ["conflicting", /SESSIONS must be class SessionDO/],
  ["kv-migration", /new_classes/],
  ["toml-project", /wrangler\.toml is not supported/],
])("%s is refused before anything is written", async (fixture, pattern) => {
  const dir = copyFixture(fixture);
  try {
    const before = snapshot(dir);
    await expect(runInit(base(dir))).rejects.toSatisfy(conflict(pattern));
    expect(snapshot(dir)).toEqual(before);
  } finally {
    cleanup(dir);
  }
});

it("the executable reports a conflict with exit code 1 and the ✖ prefix", () => {
  const dir = copyFixture("conflicting");
  try {
    let failure: { status?: number; stderr?: string } | undefined;
    try {
      execFileSync("node", [cliPath, "init", "--yes", dir], {
        env: { ...process.env, ...offline },
        encoding: "utf8",
        stdio: "pipe",
      });
    } catch (error) {
      failure = error as { status?: number; stderr?: string };
    }
    expect(failure?.status).toBe(1);
    expect(failure?.stderr).toMatch(/✖ .*SESSIONS/);
    expect(existsSync(join(dir, "src/agents.ts"))).toBe(false);
  } finally {
    cleanup(dir);
  }
});

it("provider and harness flags shape the composition", async () => {
  const dir = copyFixture("vite-project");
  try {
    await runInit(
      base(dir, {
        provider: "anthropic",
        harnesses: ["claude-code"],
        workersAi: true,
        codeLoader: false,
      }),
    );
    const agents = read(dir, "src/agents.ts");
    expect(agents).toMatch(/protocol: "anthropic"/);
    expect(agents).not.toMatch(/createAnthropic/);
    expect(agents).toMatch(
      /claude: \{\n\s+harness: "claude-code",\n\s+model: "opus",\n\s+tiers: \{ haiku: "haiku", sonnet: "sonnet" \},\n\s+webSearch: true,\n\s+\},/,
    );
    expect(agents).toMatch(/opus: \(\) =>\n\s+nativeModel\(\{[\s\S]*?model: "claude-opus-5"/);
    expect(agents).toMatch(
      /haiku: \(\) =>\n\s+nativeModel\(\{[\s\S]*?model: "claude-haiku-4-5-20251001"/,
    );
    expect(agents).toMatch(/workers: \{ harness: "claude-code", model: "workers" \}/);
    expect(agents).toMatch(/workersQwen: \(\) =>/);
    expect(agents).not.toMatch(/codex:/);
    expect(read(dir, "wrangler.jsonc")).toMatch(
      /"ai": \{\n\s+"binding": "AI",\n\s+"remote": true\n\s+\}/,
    );
    expect(read(dir, "wrangler.jsonc")).not.toMatch(/CODE_LOADER/);
    expect(parseDevVars(read(dir, ".dev.vars")).get("ANTHROPIC_API_KEY")).toBe("");
    const manifest = readJson<Manifest>(dir, "package.json");
    expect(manifest.dependencies["@ai-sdk/anthropic"]).toBeUndefined();
    expect(manifest.dependencies["workers-ai-provider"]).toBeDefined();
    expect(manifest.dependencies["@ai-sdk/openai"]).toBeDefined();
  } finally {
    cleanup(dir);
  }
});

it("--library and --cli-package write file: dependencies for pre-publication runs", async () => {
  const dir = copyFixture("vite-project");
  try {
    await runInit(base(dir, { library: "/tmp/lib.tgz", cliPackage: "/tmp/cli.tgz" }));
    const manifest = readJson<Manifest>(dir, "package.json");
    expect(manifest.dependencies["cf-open-agents-api"]).toBe("file:/tmp/lib.tgz");
    expect(manifest.devDependencies["create-cf-open-agents-api"]).toBe("file:/tmp/cli.tgz");
  } finally {
    cleanup(dir);
  }
});

it("the demo publishes on workers.dev and warns that the page has no login", () => {
  const dir = emptyDirectory();
  try {
    const output = execFileSync(
      "node",
      [cliPath, "init", "--yes", "--template", "demo", "--no-rootless", dir],
      { env: { ...process.env, ...offline }, encoding: "utf8", stdio: "pipe" },
    );
    expect(output).toMatch(/no login/);
    expect(output).toMatch(/workers_dev: false/);
    expect(read(dir, "wrangler.jsonc")).toMatch(/"workers_dev": true/);
  } finally {
    cleanup(dir);
  }
});
