import { appendFileSync } from "node:fs";
import { join } from "node:path";

import { expect, it } from "vitest";

import { accountIds, CliError, runInit, runSetup, type SetupOptions } from "../src/index.js";
import { initOptions, silent, withEmptyDirectory, withFixture } from "./helpers.js";

it("extracts account ids from wrangler whoami output", () => {
  const output = `
┌──────────────┬──────────────────────────────────┐
│ Account Name │ Account ID                       │
├──────────────┼──────────────────────────────────┤
│ Personal     │ 0123456789abcdef0123456789abcdef │
│ Work         │ fedcba9876543210fedcba9876543210 │
└──────────────┴──────────────────────────────────┘`;
  expect(accountIds(output)).toEqual([
    "0123456789abcdef0123456789abcdef",
    "fedcba9876543210fedcba9876543210",
  ]);
  expect(accountIds("not logged in")).toEqual([]);
});

it("creates the buckets and puts every secret in one wrangler call, reading values from the environment", async () => {
  await withFixture("vite-project", async (dir) => {
    await runInit(initOptions(dir));
    const calls: { args: string[]; input?: string }[] = [];
    const runner = (_command: string, args: readonly string[], options?: { input?: string }) => {
      calls.push({ args: [...args], input: options?.input });
      if (args.includes("create") && args.includes("my-app-workspaces"))
        return { ok: false, stdout: "", stderr: "A bucket with that name already exists" };
      return { ok: true, stdout: "", stderr: "" };
    };
    const env = {
      API_TOKEN: "p".repeat(40),
      OPENAI_API_KEY: "sk-prod",
      R2_ACCESS_KEY_ID: "id",
      R2_SECRET_ACCESS_KEY: "secret",
      CLOUDFLARE_R2_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
    };
    const options: SetupOptions = {
      dir,
      dryRun: false,
      fromEnv: true,
      skipSecrets: false,
      skipBuckets: false,
      runner,
      env,
      reporter: silent(),
    };
    const plan = await runSetup(options);
    expect(plan.created).toEqual(["r2 bucket my-app-checkpoints"]);
    expect(plan.skipped).toEqual(["r2 bucket my-app-workspaces"]);
    expect(plan.updated).toEqual([
      "secrets API_TOKEN, OPENAI_API_KEY, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, CLOUDFLARE_R2_ACCOUNT_ID",
    ]);
    const bulk = calls.find((call) => call.args.includes("bulk"));
    expect(bulk?.args).toEqual(["wrangler", "secret", "bulk", "--config", "wrangler.jsonc"]);
    expect(JSON.parse(bulk?.input ?? "{}")).toEqual(env);
    expect(
      calls.filter((call) => call.args.includes("create")).map((call) => call.args.at(-3)),
    ).toEqual(["my-app-checkpoints", "my-app-workspaces"]);
    const missing = await runSetup({ ...options, env: { ...env, R2_SECRET_ACCESS_KEY: "" } }).catch(
      (error: unknown) => error,
    );
    expect(missing).toBeInstanceOf(CliError);
    expect((missing as CliError).message).toMatch(/R2_SECRET_ACCESS_KEY is not set/);
  });
});

it("uploads a provider key added to .dev.vars by hand next to the recorded one", async () => {
  await withEmptyDirectory(async (dir) => {
    await runInit(initOptions(dir, { template: "minimal", provider: "anthropic" }));
    // A composition extended by hand with a second provider reads a key the record does not
    // name. The record decides what init writes; it must not decide what production keeps.
    appendFileSync(join(dir, ".dev.vars"), "OPENAI_API_KEY=sk-second\n");
    const calls: { args: string[]; input?: string }[] = [];
    const env = {
      API_TOKEN: "p".repeat(40),
      OPENAI_API_KEY: "sk-second",
      ANTHROPIC_API_KEY: "sk-recorded",
      R2_ACCESS_KEY_ID: "id",
      R2_SECRET_ACCESS_KEY: "secret",
      CLOUDFLARE_R2_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
    };
    const plan = await runSetup({
      dir,
      dryRun: false,
      fromEnv: true,
      skipSecrets: false,
      skipBuckets: true,
      env,
      reporter: silent(),
      runner: (_command, args, options?: { input?: string }) => {
        calls.push({ args: [...args], input: options?.input });
        return { ok: true, stdout: "", stderr: "" };
      },
    });
    expect(plan.updated).toEqual([
      "secrets API_TOKEN, OPENAI_API_KEY, ANTHROPIC_API_KEY, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, CLOUDFLARE_R2_ACCOUNT_ID",
    ]);
    // --from-env reads the union the same way, so neither key is dropped on the way up.
    expect(JSON.parse(calls.find((call) => call.args.includes("bulk"))?.input ?? "{}")).toEqual(
      env,
    );
  });
});

it("a dry run prints the commands and calls nothing", async () => {
  await withFixture("vite-project", async (dir) => {
    await runInit(initOptions(dir));
    const calls: string[][] = [];
    const runner = (_command: string, args: readonly string[]) => {
      calls.push([...args]);
      return { ok: true, stdout: "", stderr: "" };
    };
    const plan = await runSetup({
      dir,
      dryRun: true,
      fromEnv: false,
      skipSecrets: false,
      skipBuckets: false,
      runner,
      reporter: silent(),
    });
    expect(calls).toEqual([]);
    expect(plan.notes.join("\n")).toMatch(
      /Would run npx wrangler r2 bucket create my-app-checkpoints --config wrangler.jsonc/,
    );
    expect(plan.notes.join("\n")).toMatch(
      /Would run npx wrangler secret bulk --config wrangler.jsonc with the values on stdin/,
    );
  });
});

it("refuses a directory without a Wrangler configuration", async () => {
  await withEmptyDirectory(async (dir) => {
    await expect(
      runSetup({
        dir,
        dryRun: true,
        fromEnv: false,
        skipSecrets: false,
        skipBuckets: false,
        reporter: silent(),
      }),
    ).rejects.toSatisfy(
      (error: unknown) => error instanceof CliError && /init first/.test(error.message),
    );
  });
});
