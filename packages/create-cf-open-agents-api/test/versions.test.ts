import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, it } from "vitest";

import { versions } from "../src/index.js";
import { packageRoot, repoRoot } from "./helpers.js";

interface PackageManifest {
  name: string;
  version: string;
  peerDependencies?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}
const manifest = (path: string): PackageManifest =>
  JSON.parse(readFileSync(join(repoRoot, path), "utf8")) as PackageManifest;
const exact = (range: string) => range.replace(/^\^/, "");

it("the generated pins agree with the workspace", () => {
  const library = manifest("packages/agent-api/package.json");
  const example = manifest("examples/worker/package.json");
  const root = manifest("package.json");
  const cli = manifest("packages/create-cf-open-agents-api/package.json");
  expect(library.name).toBe(versions.LIBRARY_NAME);
  expect(cli.name).toBe(versions.CLI_NAME);
  expect(cli.version).toBe(library.version);
  expect(versions.CLI_VERSION).toBe(cli.version);
  for (const [name, version] of Object.entries(versions.PEER_VERSIONS)) {
    const peer = library.peerDependencies?.[name] ?? library.dependencies?.[name] ?? "";
    expect(exact(peer), name).toBe(version);
  }
  for (const [name, version] of Object.entries(versions.PROVIDER_VERSIONS)) {
    if (name === "@ai-sdk/anthropic") expect(cli.devDependencies?.[name], name).toBe(version);
    else expect(example.dependencies?.[name], name).toBe(version);
    expect(cli.devDependencies?.[name], `${name} in the CLI's devDependencies`).toBe(version);
  }
  expect(versions.TOOLCHAIN_VERSIONS.wrangler).toBe(root.devDependencies?.wrangler);
  expect(versions.TOOLCHAIN_VERSIONS["@cloudflare/workers-types"]).toBe(
    root.devDependencies?.["@cloudflare/workers-types"],
  );
  expect(readFileSync(join(packageRoot, "package.json"), "utf8")).toContain(
    `"version": "${versions.CLI_VERSION}"`,
  );
  const demo = manifest("examples/demo/package.json");
  for (const [name, version] of Object.entries(versions.DEMO_VERSIONS))
    expect(demo.dependencies?.[name], name).toBe(version);
  for (const [name, version] of Object.entries(versions.PROVIDER_VERSIONS))
    if (name !== "@ai-sdk/anthropic") expect(demo.dependencies?.[name], name).toBe(version);
});

it("the compatibility date is the one the workspace examples run with", () => {
  for (const file of ["examples/worker/wrangler.jsonc", "examples/demo/wrangler.jsonc"])
    expect(readFileSync(join(repoRoot, file), "utf8"), file).toContain(
      `"compatibility_date": "${versions.COMPATIBILITY_DATE}"`,
    );
});
