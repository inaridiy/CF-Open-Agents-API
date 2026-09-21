import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, it } from "vitest";

import {
  CliError,
  ensureVendor,
  readCompositionRecord,
  readVendorManifest,
  versions,
} from "../src/index.js";
import { swapSnapshot } from "../src/steps/vendor.js";
import { repoRoot, withEmptyDirectory } from "./helpers.js";

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
  await withEmptyDirectory(async (root) => {
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
      "LICENSE",
      "NOTICE",
      "manifest.json",
    ])
      expect(existsSync(join(vendor, file)), file).toBe(true);
    // Only what the Harness Dockerfile builds: the setup CLI and the examples cannot break
    // the image because they are not in its build context at all.
    for (const excluded of [
      "packages/agent-api/dist",
      "packages/agent-api/node_modules",
      "packages/create-cf-open-agents-api",
      "examples",
      "docs",
      "tests",
      "scripts",
      ".git",
    ])
      expect(existsSync(join(vendor, excluded)), excluded).toBe(false);
    expect(readdirSync(join(vendor, "packages")).sort()).toEqual(["agent-api", "supervisor"]);
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
  });
});

it("keeps the composition record when the snapshot is replaced", async () => {
  await withEmptyDirectory(async (root) => {
    await ensureVendor(snapshotOptions(root));
    const record = join(root, ".cf-open-agents-api", "composition.json");
    writeFileSync(
      record,
      '{ "provider": "anthropic", "harnesses": ["codex"], "workersAi": false }',
    );
    // The postinstall hook swaps the whole directory; what init recorded there survives it.
    expect(await ensureVendor(snapshotOptions(root, { force: true }))).toMatchObject({
      status: "updated",
    });
    expect(readCompositionRecord(root)).toEqual({
      provider: "anthropic",
      harnesses: ["codex"],
      workersAi: false,
    });
  });
});

it("a snapshot that fails to land leaves no truncated build context", async () => {
  await withEmptyDirectory(async (root) => {
    const target = join(root, ".cf-open-agents-api");
    const staged = join(root, "staged");
    mkdirSync(staged, { recursive: true });
    writeFileSync(join(staged, "manifest.json"), "{}\n");
    /** A copy that has already written part of the directory when the disk gives out. */
    const halfway = (_from: string, to: string) => {
      mkdirSync(to, { recursive: true });
      writeFileSync(join(to, "manifest.json"), "{}\n");
      throw new Error("disk full");
    };
    // The first snapshot has nothing to restore, so the half-written directory must go: the
    // project's wrangler.jsonc already points the two Dockerfiles at this build context.
    expect(() => swapSnapshot(staged, target, halfway)).toThrow(/disk full/);
    expect(existsSync(target)).toBe(false);
    expect(existsSync(`${target}.previous`)).toBe(false);
    // With a snapshot already in place, that one comes back whole instead.
    await ensureVendor(snapshotOptions(root));
    const before = readFileSync(join(target, "manifest.json"), "utf8");
    expect(() => swapSnapshot(staged, target, halfway)).toThrow(/disk full/);
    expect(readFileSync(join(target, "manifest.json"), "utf8")).toBe(before);
    expect(existsSync(join(target, "docker", "Harness.Dockerfile"))).toBe(true);
    expect(existsSync(`${target}.previous`)).toBe(false);
  });
});

it("explains a missing tag archive and points at --source", async () => {
  await withEmptyDirectory(async (root) => {
    const fetch = () => Promise.resolve(new Response(null, { status: 404 }));
    await expect(
      ensureVendor(snapshotOptions(root, { source: undefined, fetch })),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof CliError &&
        /No source archive for v.* --source <checkout>/.test(error.message),
    );
    expect(existsSync(join(root, ".cf-open-agents-api"))).toBe(false);
  });
});

it("downloads the archive and extracts it with tar", async () => {
  await withEmptyDirectory(async (root) => {
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
  });
});

it("a dry run and the skip variable leave the directory alone", async () => {
  await withEmptyDirectory(async (root) => {
    const dry = await ensureVendor(snapshotOptions(root, { dryRun: true }));
    expect(dry.status).toBe("created");
    expect(dry.note).toMatch(/Would snapshot/);
    const skipped = await ensureVendor(
      snapshotOptions(root, { env: { CF_OPEN_AGENTS_API_SKIP_VENDOR: "1" } }),
    );
    expect(skipped.status).toBe("skipped");
    expect(existsSync(join(root, ".cf-open-agents-api"))).toBe(false);
  });
});

it("rejects a directory that is not a checkout", async () => {
  await withEmptyDirectory(async (root) => {
    await withEmptyDirectory(async (source) => {
      await expect(ensureVendor(snapshotOptions(root, { source }))).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof CliError && /is not a CF-Open-Agents-API checkout/.test(error.message),
      );
    });
  });
});
