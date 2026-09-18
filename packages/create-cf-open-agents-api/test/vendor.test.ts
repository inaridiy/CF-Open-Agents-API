import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { expect, it } from "vitest";

import { CliError, ensureVendor, readVendorManifest, versions } from "../src/index.js";
import { cleanup, emptyDirectory, repoRoot } from "./helpers.js";

const snapshotOptions = (root: string, extra = {}) => ({
  root,
  version: versions.CLI_VERSION,
  source: repoRoot,
  force: false,
  dryRun: false,
  env: {},
  ...extra,
});

it("copies what the Dockerfiles need from a local checkout, and nothing else", async () => {
  const root = emptyDirectory();
  try {
    const first = await ensureVendor(snapshotOptions(root));
    expect(first).toEqual({ status: "created", file: ".cf-open-agents-api/" });
    const vendor = join(root, ".cf-open-agents-api");
    for (const file of [
      "docker/Harness.Dockerfile",
      "docker/Sandbox.Dockerfile",
      "packages/agent-api/package.json",
      "packages/agent-api/src/index.ts",
      "packages/supervisor/package.json",
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "tsconfig.json",
      ".dockerignore",
      "examples/worker/package.json",
      "LICENSE",
      "NOTICE",
      "manifest.json",
    ])
      expect(existsSync(join(vendor, file)), file).toBe(true);
    for (const excluded of [
      "packages/agent-api/dist",
      "packages/agent-api/node_modules",
      "packages/create-cf-open-agents-api/test",
      "docs",
      "tests",
      "scripts",
      ".git",
    ])
      expect(existsSync(join(vendor, excluded)), excluded).toBe(false);
    expect(readdirSync(join(vendor, "examples"))).toEqual(["worker"]);
    const manifest = readVendorManifest(root);
    expect(manifest).toMatchObject({
      name: "cf-open-agents-api",
      version: versions.CLI_VERSION,
      ref: `v${versions.CLI_VERSION}`,
      source: repoRoot,
    });
    expect(await ensureVendor(snapshotOptions(root))).toMatchObject({ status: "skipped" });
    expect(await ensureVendor(snapshotOptions(root, { force: true }))).toMatchObject({
      status: "updated",
    });
  } finally {
    cleanup(root);
  }
});

it("explains a missing tag archive and points at --source", async () => {
  const root = emptyDirectory();
  try {
    const fetch = () => Promise.resolve(new Response(null, { status: 404 }));
    await expect(
      ensureVendor(snapshotOptions(root, { source: undefined, fetch })),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof CliError &&
        /No source archive for v.* --source <checkout>/.test(error.message),
    );
    expect(existsSync(join(root, ".cf-open-agents-api"))).toBe(false);
  } finally {
    cleanup(root);
  }
});

it("downloads the archive and extracts it with tar", async () => {
  const root = emptyDirectory();
  try {
    let requested = "";
    const fetch = (input: string | URL | Request) => {
      requested = typeof input === "string" ? input : "unexpected";
      return Promise.resolve(new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    };
    const calls: string[][] = [];
    const runner = (command: string, args: readonly string[]) => {
      calls.push([command, ...args]);
      return { ok: false, stdout: "", stderr: "tar: not a gzip archive" };
    };
    await expect(
      ensureVendor(snapshotOptions(root, { source: undefined, fetch, runner, ref: "main" })),
    ).rejects.toSatisfy(
      (error: unknown) => error instanceof CliError && /tar on PATH/.test(error.message),
    );
    expect(requested).toBe("https://github.com/inaridiy/CF-Open-Agents-API/archive/main.tar.gz");
    expect(calls[0]?.slice(0, 2)).toEqual(["tar", "-xzf"]);
    expect(calls[0]).toContain("--strip-components=1");
  } finally {
    cleanup(root);
  }
});

it("a dry run and the skip variable leave the directory alone", async () => {
  const root = emptyDirectory();
  try {
    const dry = await ensureVendor(snapshotOptions(root, { dryRun: true }));
    expect(dry.status).toBe("created");
    expect(dry.note).toMatch(/Would snapshot/);
    const skipped = await ensureVendor(
      snapshotOptions(root, { env: { CF_OPEN_AGENTS_API_SKIP_VENDOR: "1" } }),
    );
    expect(skipped.status).toBe("skipped");
    expect(existsSync(join(root, ".cf-open-agents-api"))).toBe(false);
  } finally {
    cleanup(root);
  }
});

it("rejects a directory that is not a checkout", async () => {
  const root = emptyDirectory();
  const source = emptyDirectory();
  try {
    await expect(ensureVendor(snapshotOptions(root, { source }))).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof CliError && /is not a CF-Open-Agents-API checkout/.test(error.message),
    );
  } finally {
    cleanup(root);
    cleanup(source);
  }
});
