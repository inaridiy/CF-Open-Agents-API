import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, it } from "vitest";

import {
  CliError,
  configChecks,
  devVarsCheck,
  readVendorManifest,
  runDoctor,
  runInit,
  snapshotCheck,
  versions,
} from "../src/index.js";
import { parseJsonc } from "../src/jsonc.js";
import { emptyDirectory, initOptions, read, repoRoot, withFixture } from "./helpers.js";

const failing = (checks: readonly { name: string; ok: boolean }[]) =>
  checks.filter((check) => !check.ok).map((check) => check.name);

it("a generated configuration passes every agreement rule", async () => {
  await withFixture("vite-project", async (dir) => {
    await runInit(initOptions(dir));
    const config = parseJsonc<Parameters<typeof configChecks>[0]>(
      read(dir, "wrangler.jsonc"),
      "wrangler.jsonc",
    );
    expect(failing(configChecks(config))).toEqual([]);
    expect(failing(configChecks({ ...config, name: "renamed" }))).toEqual([
      "services.MODEL_GATEWAY",
      "services.AGENTS",
    ]);
    expect(failing(configChecks({ ...config, vars: { BACKUP_BUCKET_NAME: "other" } }))).toEqual([
      "vars.BACKUP_BUCKET_NAME",
    ]);
    expect(failing(configChecks({ ...config, migrations: [] }))).toEqual([
      "migrations.SessionDO",
      "migrations.TenantCatalogDO",
      "migrations.HarnessDO",
      "migrations.SandboxDO",
    ]);
    expect(failing(configChecks({ ...config, compatibility_flags: [] }))).toEqual([
      "compatibility_flags.nodejs_compat",
      "compatibility_flags.enable_ctx_exports",
    ]);
  });
});

it("init and doctor agree that a class renamed to SessionDO has SQLite storage", async () => {
  await withFixture("renamed-class", async (dir) => {
    await runInit(initOptions(dir));
    // init leaves the renamed class alone and adds a migration for the other three only.
    const wrangler = read(dir, "wrangler.jsonc");
    expect(wrangler).toMatch(
      /"new_sqlite_classes": \["TenantCatalogDO", "HarnessDO", "SandboxDO"\]/,
    );
    expect(wrangler).not.toMatch(/"new_sqlite_classes": \[[^\]]*"SessionDO"/);
    // doctor used to read new_sqlite_classes alone and call the result broken.
    const report = runDoctor({ dir, offline: true });
    expect(failing(report.checks)).toEqual(["image snapshot"]);
    expect(report.checks.find((item) => item.name === "migrations.SessionDO")?.detail).toBe(
      "renamed_classes",
    );
  });
});

it("init and doctor both refuse a class renamed from a KV one", async () => {
  await withFixture("kv-renamed-class", async (dir) => {
    // The rename chain ends in new_classes, so SessionDO has KV storage however often it
    // was renamed; init used to accept this and doctor used to call it SQLite.
    await expect(runInit(initOptions(dir))).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof CliError && /renamed from LegacySession/.test(error.message),
    );
    const report = runDoctor({ dir, offline: true });
    expect(failing(report.checks)).toContain("migrations.SessionDO");
    expect(report.checks.find((item) => item.name === "migrations.SessionDO")?.detail).toBe(
      "renamed from LegacySession, which is in new_classes",
    );
    // A rename cycle says nothing about storage, and following it must still terminate.
    const cycled = configChecks({
      name: "cycles",
      migrations: [
        { tag: "v1", renamed_classes: [{ from: "SessionDO", to: "Temporary" }] },
        { tag: "v2", renamed_classes: [{ from: "Temporary", to: "SessionDO" }] },
      ],
    });
    expect(cycled.find((item) => item.name === "migrations.SessionDO")).toMatchObject({
      ok: false,
      detail: "not in new_sqlite_classes",
    });
  });
});

it("the snapshot and .dev.vars checks name what is wrong", () => {
  const absent = snapshotCheck(readVendorManifest(emptyDirectory()), "0.2.0");
  expect(absent.ok).toBe(false);
  expect(absent.detail).toMatch(/vendor/);
  expect(
    snapshotCheck(
      { name: "x", version: "0.1.0", ref: "v0.1.0", source: "github", createdAt: "" },
      "0.2.0",
    ),
  ).toMatchObject({
    ok: false,
    detail: "0.1.0 (CLI 0.2.0)",
  });
  const missing = [".dev.vars"].find((file) => file === "absent");
  expect(devVarsCheck(missing)).toMatchObject({ ok: false, detail: "file missing" });
  expect(devVarsCheck("API_TOKEN=short\n")).toMatchObject({ ok: false, detail: "5 characters" });
  expect(devVarsCheck(`API_TOKEN=${"x".repeat(32)}\n`)).toMatchObject({ ok: true });
});

it("runDoctor combines the file checks with the tool checks through the runner", async () => {
  await withFixture("vite-project", async (dir) => {
    await runInit(initOptions(dir, { source: repoRoot, env: {} }));
    const calls: string[] = [];
    const runner = (command: string, args: readonly string[]) => {
      calls.push([command, ...args].join(" "));
      if (args.includes("whoami"))
        return { ok: true, stdout: "You are not authenticated.", stderr: "" };
      if (args.includes("--version")) return { ok: true, stdout: "4.131.1\n", stderr: "" };
      return { ok: false, stdout: "", stderr: "Cannot connect to the Docker daemon" };
    };
    const report = runDoctor({ dir, runner, cliVersion: versions.CLI_VERSION });
    expect(report.ok).toBe(false);
    expect(failing(report.checks)).toEqual(["docker", "wrangler login"]);
    expect(calls).toEqual([
      "npx wrangler --version",
      "docker info --format {{json .SecurityOptions}}",
      "npx wrangler whoami",
    ]);
    writeFileSync(join(dir, ".dev.vars"), "API_TOKEN=short\n");
    expect(failing(runDoctor({ dir, offline: true }).checks)).toEqual([".dev.vars API_TOKEN"]);
  });
});

it("a docker info that times out fails the docker check and skips the rootless check", async () => {
  await withFixture("vite-project", async (dir) => {
    await runInit(initOptions(dir));
    const timeouts: (number | undefined)[] = [];
    const stalled = (
      command: string,
      args: readonly string[],
      options?: { timeoutMs?: number },
    ) => {
      if (command === "docker") {
        timeouts.push(options?.timeoutMs);
        return { ok: false, stdout: "", stderr: "timed out", timedOut: true };
      }
      if (args.includes("--version")) return { ok: true, stdout: "4.131.1\n", stderr: "" };
      return { ok: true, stdout: "You are logged in", stderr: "" };
    };
    const report = runDoctor({ dir, runner: stalled, cliVersion: versions.CLI_VERSION });
    expect(timeouts).toEqual([5000]);
    expect(failing(report.checks)).toEqual(["image snapshot", "docker"]);
    expect(report.checks.find((check) => check.name === "docker")?.detail).toMatch(
      /did not answer within 5000 ms/,
    );
  });
});

it("a rootless engine needs the dev:rootless script", async () => {
  await withFixture("vite-project", async (dir) => {
    const rootless = (command: string, args: readonly string[]) => {
      if (command === "docker")
        return {
          ok: true,
          stdout: '["name=seccomp,profile=builtin","name=rootless"]\n',
          stderr: "",
        };
      if (args.includes("--version")) return { ok: true, stdout: "4.131.1\n", stderr: "" };
      return { ok: true, stdout: "You are logged in", stderr: "" };
    };
    await runInit(initOptions(dir));
    const without = runDoctor({ dir, runner: rootless, cliVersion: versions.CLI_VERSION });
    expect(failing(without.checks)).toEqual(["image snapshot", "docker rootless"]);
    expect(without.checks.find((check) => check.name === "docker rootless")?.detail).toMatch(
      /init --rootless.*temporary workaround/,
    );
    await runInit(initOptions(dir, { rootless: true }));
    const withScript = runDoctor({ dir, runner: rootless, cliVersion: versions.CLI_VERSION });
    expect(failing(withScript.checks)).toEqual(["image snapshot"]);
  });
});
