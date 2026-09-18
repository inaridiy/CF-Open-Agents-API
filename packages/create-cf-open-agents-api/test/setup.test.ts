import { expect, it } from "vitest";

import { accountIds, CliError, runInit, runSetup, type SetupOptions } from "../src/index.js";
import { cleanup, copyFixture, emptyDirectory, offline, silent } from "./helpers.js";

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
  } finally {
    cleanup(dir);
  }
});

it("a dry run prints the commands and calls nothing", async () => {
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
  } finally {
    cleanup(dir);
  }
});

it("refuses a directory without a Wrangler configuration", async () => {
  const dir = emptyDirectory();
  try {
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
  } finally {
    cleanup(dir);
  }
});
