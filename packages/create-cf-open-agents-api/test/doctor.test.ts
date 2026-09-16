import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, it } from "vitest";

import {
  configChecks,
  devVarsCheck,
  readVendorManifest,
  runDoctor,
  runInit,
  snapshotCheck,
  versions,
} from "../dist/index.js";
import {
  cleanup,
  copyFixture,
  emptyDirectory,
  offline,
  read,
  repoRoot,
  silent,
} from "./helpers.js";

const failing = (checks: readonly { name: string; ok: boolean }[]) =>
  checks.filter((check) => !check.ok).map((check) => check.name);

it("a generated configuration passes every agreement rule", async () => {
  const dir = copyFixture("vite-project");
  try {
    await runInit({
      dir,
      yes: true,
      force: false,
      dryRun: false,
      env: offline,
      reporter: silent(),
    });
    const config = JSON.parse(
      read(dir, "wrangler.jsonc")
        .replace(/^\s*\/\/.*$/gm, "")
        .replace(/,(\s*[}\]])/g, "$1"),
    ) as Parameters<typeof configChecks>[0];
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
  } finally {
    cleanup(dir);
  }
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
  const dir = copyFixture("vite-project");
  try {
    await runInit({
      dir,
      yes: true,
      force: false,
      dryRun: false,
      source: repoRoot,
      reporter: silent(),
      env: {},
    });
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
    expect(calls).toEqual(["npx wrangler --version", "docker info", "npx wrangler whoami"]);
    writeFileSync(join(dir, ".dev.vars"), "API_TOKEN=short\n");
    expect(failing(runDoctor({ dir, offline: true }).checks)).toEqual([".dev.vars API_TOKEN"]);
  } finally {
    cleanup(dir);
  }
});
