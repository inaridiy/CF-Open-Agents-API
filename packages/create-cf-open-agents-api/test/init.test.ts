import { execFileSync } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, it } from "vitest";

import {
  CliError,
  parseDevVars,
  readCompositionRecord,
  runInit,
  runSetup,
  versions,
} from "../src/index.js";
import {
  cliPath,
  initOptions,
  type Manifest,
  offline,
  read,
  readJson,
  repoRoot,
  silent,
  snapshot,
  withEmptyDirectory,
  withFixture,
} from "./helpers.js";

const conflict = (pattern: RegExp) => (error: unknown) =>
  error instanceof CliError && pattern.test(error.message);

it("retrofit adds the API to an existing Vite Worker project", async () => {
  await withFixture("vite-project", async (dir) => {
    const { plan, answers } = await runInit(initOptions(dir));
    expect(answers.harnesses).toEqual(["codex", "claude-code", "opencode"]);
    expect(plan.created).toEqual([
      "src/agents.ts",
      ".cf-open-agents-api/composition.json",
      ".dev.vars.example",
    ]);
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
  });
});

it("a second run changes nothing", async () => {
  await withFixture("vite-project", async (dir) => {
    await runInit(initOptions(dir));
    const before = snapshot(dir);
    const { plan } = await runInit(initOptions(dir));
    expect(plan.created).toEqual([]);
    expect(plan.updated).toEqual([]);
    expect(snapshot(dir)).toEqual(before);
  });
});

it("a dry run reports the plan and writes nothing", async () => {
  await withFixture("vite-project", async (dir) => {
    const before = snapshot(dir);
    const { plan } = await runInit(initOptions(dir, { dryRun: true }));
    expect(plan.created).toContain("src/agents.ts");
    expect(plan.updated).toContain("wrangler.jsonc");
    expect(snapshot(dir)).toEqual(before);
  });
});

it("--force rewrites a diverged composition and gateway binding", async () => {
  await withFixture("vite-project", async (dir) => {
    await runInit(initOptions(dir));
    writeFileSync(join(dir, "src/agents.ts"), "// edited\n");
    const diverged = read(dir, "wrangler.jsonc").replace(
      '"entrypoint": "Models"',
      '"entrypoint": "Other"',
    );
    writeFileSync(join(dir, "wrangler.jsonc"), diverged);
    await expect(runInit(initOptions(dir))).rejects.toSatisfy(conflict(/MODEL_GATEWAY/));
    const forced = await runInit(initOptions(dir, { force: true }));
    expect(forced.plan.updated).toContain("src/agents.ts");
    expect(read(dir, "wrangler.jsonc")).toMatch(/"entrypoint": "Models"/);
    expect(read(dir, "src/agents.ts")).toMatch(/defineAgentWorker/);
  });
});

it("an edited composition is kept without --force", async () => {
  await withFixture("vite-project", async (dir) => {
    await runInit(initOptions(dir));
    writeFileSync(join(dir, "src/agents.ts"), "// edited\n");
    const { plan } = await runInit(initOptions(dir));
    expect(plan.skipped).toContain("src/agents.ts");
    expect(read(dir, "src/agents.ts")).toBe("// edited\n");
    expect(plan.notes.join("\n")).toMatch(/--force rewrites it/);
  });
});

it("a re-run follows the composition it already generated, not the defaults", async () => {
  await withFixture("vite-project", async (dir) => {
    await runInit(initOptions(dir, { provider: "anthropic", harnesses: ["claude-code"] }));
    expect(readCompositionRecord(dir)).toEqual({
      provider: "anthropic",
      harnesses: ["claude-code"],
      workersAi: false,
    });
    const before = snapshot(dir);
    // The default provider is openai; without the record the second run would add its
    // packages and its key next to the anthropic composition it keeps.
    const { answers, plan } = await runInit(initOptions(dir));
    expect(answers.provider).toBe("anthropic");
    expect(answers.harnesses).toEqual(["claude-code"]);
    expect(plan.notes.join("\n")).toMatch(/existing composition decided the model provider/);
    expect(snapshot(dir)).toEqual(before);
    // The fixture's own .dev.vars already carries an OPENAI_API_KEY; the generated example
    // is what the run decides, and it must name the anthropic key alone.
    const example = parseDevVars(read(dir, ".dev.vars.example"));
    expect(example.has("OPENAI_API_KEY")).toBe(false);
    expect(parseDevVars(read(dir, ".dev.vars")).has("ANTHROPIC_API_KEY")).toBe(true);
    const manifest = readJson<Manifest>(dir, "package.json");
    expect(manifest.dependencies["@ai-sdk/openai"]).toBeUndefined();
    // setup asks for the recorded provider's key, plus any other provider key .dev.vars
    // already carries: the fixture's OPENAI_API_KEY belongs to the project this CLI
    // retrofitted, and dropping it from the bulk upload would break it in production.
    const calls: { args: string[] }[] = [];
    const plans = await runSetup({
      dir,
      dryRun: true,
      fromEnv: false,
      skipSecrets: false,
      skipBuckets: false,
      runner: (_command, args) => {
        calls.push({ args: [...args] });
        return { ok: true, stdout: "", stderr: "" };
      },
      reporter: silent(),
    });
    expect(plans.updated).toEqual([
      "secrets API_TOKEN, OPENAI_API_KEY, ANTHROPIC_API_KEY, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, CLOUDFLARE_R2_ACCOUNT_ID",
    ]);
  });
});

it("a composition generated before the record still decides the dependencies", async () => {
  await withFixture("vite-project", async (dir) => {
    await runInit(initOptions(dir, { provider: "anthropic" }));
    // A project from an earlier CLI, or one whose git-ignored snapshot was never restored.
    rmSync(join(dir, ".cf-open-agents-api"), { recursive: true, force: true });
    const { answers } = await runInit(initOptions(dir));
    expect(answers.provider).toBe("anthropic");
    expect(readJson<Manifest>(dir, "package.json").dependencies["@ai-sdk/openai"]).toBeUndefined();
    expect(parseDevVars(read(dir, ".dev.vars.example")).has("OPENAI_API_KEY")).toBe(false);
  });
});

it("a flag the kept module does not implement is reported, never half-applied", async () => {
  await withFixture("vite-project", async (dir) => {
    await runInit(initOptions(dir, { provider: "anthropic", harnesses: ["claude-code"] }));
    const before = snapshot(dir);
    // --workers-ai used to add the AI binding to wrangler.jsonc next to a module with no
    // Workers AI preset and no package or key to serve it.
    const { plan } = await runInit(initOptions(dir, { provider: "openai", workersAi: true }));
    expect(plan.skipped).toContain("src/agents.ts");
    expect(snapshot(dir)).toEqual(before);
    expect(read(dir, "wrangler.jsonc")).not.toMatch(/"binding": "AI"/);
    const notes = plan.notes.join("\n");
    expect(notes).toMatch(/provider openai \(the module uses anthropic\)/);
    expect(notes).toMatch(/a Workers AI preset \(the module has none\)/);
    expect(notes).toMatch(/--force regenerates the module/);
  });
});

it("a kept module that belongs to no record and names no provider decides alone", async () => {
  await withFixture("vite-project", async (dir) => {
    // A fresh clone (the record is git-ignored) whose module was rewritten by hand: there is
    // nothing to read it by, so a record for the defaults would be a guess that wins forever.
    writeFileSync(join(dir, "src/agents.ts"), "// a composition written by hand\n");
    const { plan } = await runInit(initOptions(dir, { workersAi: true }));
    expect(plan.skipped).toContain("src/agents.ts");
    expect(readCompositionRecord(dir)).toBeUndefined();
    expect(existsSync(join(dir, ".cf-open-agents-api", "composition.json"))).toBe(false);
    expect(readJson<Manifest>(dir, "package.json").dependencies["@ai-sdk/openai"]).toBeUndefined();
    expect(parseDevVars(read(dir, ".dev.vars.example")).has("OPENAI_API_KEY")).toBe(false);
    expect(read(dir, "wrangler.jsonc")).not.toMatch(/"binding": "AI"/);
    expect(plan.notes.join("\n")).toMatch(/names no provider this CLI recognizes/);
  });
});

it("an edited composition keeps deciding the dependencies even against a flag", async () => {
  await withFixture("vite-project", async (dir) => {
    await runInit(initOptions(dir, { provider: "anthropic" }));
    writeFileSync(join(dir, "src/agents.ts"), "// edited by hand\n");
    const { plan } = await runInit(initOptions(dir, { provider: "openai" }));
    expect(plan.skipped).toContain("src/agents.ts");
    expect(read(dir, "src/agents.ts")).toBe("// edited by hand\n");
    expect(readJson<Manifest>(dir, "package.json").dependencies["@ai-sdk/openai"]).toBeUndefined();
    expect(parseDevVars(read(dir, ".dev.vars.example")).has("OPENAI_API_KEY")).toBe(false);
  });
});

it.each([
  ["conflicting", /SESSIONS must be class SessionDO/],
  ["kv-migration", /is declared in new_classes/],
  // A rename does not turn KV storage into SQLite storage, however many migrations it takes.
  ["kv-renamed-class", /renamed from LegacySession, which is declared in new_classes/],
  ["toml-project", /wrangler\.toml is not supported/],
])("%s is refused before anything is written", async (fixture, pattern) => {
  await withFixture(fixture, async (dir) => {
    const before = snapshot(dir);
    await expect(runInit(initOptions(dir))).rejects.toSatisfy(conflict(pattern));
    expect(snapshot(dir)).toEqual(before);
  });
});

it("a refusal after the first steps still leaves the project untouched", async () => {
  await withFixture("vite-project", async (dir) => {
    // `main` now names an entry that is not there. The refusal comes from a step that runs
    // after the ones that rewrite wrangler.jsonc and write src/agents.ts.
    rmSync(join(dir, "src/index.ts"));
    const before = snapshot(dir);
    await expect(runInit(initOptions(dir))).rejects.toSatisfy(conflict(/does not exist/));
    expect(snapshot(dir)).toEqual(before);
  });
});

it("a binding conflict refuses before the image snapshot is written", async () => {
  await withFixture("conflicting", async (dir) => {
    const before = snapshot(dir);
    // Not skipped this time: the snapshot is really staged from this checkout first.
    await expect(runInit(initOptions(dir, { env: {}, source: repoRoot }))).rejects.toSatisfy(
      conflict(/SESSIONS must be class SessionDO/),
    );
    expect(existsSync(join(dir, ".cf-open-agents-api"))).toBe(false);
    expect(snapshot(dir)).toEqual(before);
  });
});

it("the executable reports a conflict with exit code 1 and the ✖ prefix", async () => {
  await withFixture("conflicting", async (dir) => {
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
  });
});

it("provider and harness flags shape the composition", async () => {
  await withFixture("vite-project", async (dir) => {
    await runInit(
      initOptions(dir, {
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
  });
});

it("--library and --cli-package write file: dependencies for pre-publication runs", async () => {
  await withFixture("vite-project", async (dir) => {
    await runInit(initOptions(dir, { library: "/tmp/lib.tgz", cliPackage: "/tmp/cli.tgz" }));
    const manifest = readJson<Manifest>(dir, "package.json");
    expect(manifest.dependencies["cf-open-agents-api"]).toBe("file:/tmp/lib.tgz");
    expect(manifest.devDependencies["create-cf-open-agents-api"]).toBe("file:/tmp/cli.tgz");
  });
});

it("the demo publishes on workers.dev and warns that the page has no login", async () => {
  await withEmptyDirectory(async (dir) => {
    const output = execFileSync(
      "node",
      [cliPath, "init", "--yes", "--template", "demo", "--no-rootless", dir],
      { env: { ...process.env, ...offline }, encoding: "utf8", stdio: "pipe" },
    );
    expect(output).toMatch(/no login/);
    expect(output).toMatch(/workers_dev: false/);
    expect(read(dir, "wrangler.jsonc")).toMatch(/"workers_dev": true/);
  });
});
