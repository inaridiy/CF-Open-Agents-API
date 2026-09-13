import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = await mkdtemp(join(tmpdir(), "cf-package-consumer-"));
const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const library = JSON.parse(
  await readFile(new URL("../packages/agent-api/package.json", import.meta.url), "utf8"),
);
const run = (command, args, cwd) => execFileSync(command, args, { cwd, stdio: "inherit" });
try {
  run("pnpm", ["--filter", library.name, "pack", "--pack-destination", directory], root);
  const tarball = join(directory, `${library.name}-${library.version}.tgz`);
  const entries = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" });
  for (const file of ["LICENSE", "NOTICE", "CHANGELOG.md", "dist/index.js", "dist/cloudflare.d.ts"])
    assert(entries.split("\n").includes(`package/${file}`), `Missing packaged ${file}`);
  assert(
    !entries.includes(".agents/") && !entries.includes("tests/"),
    "Development files leaked into the package",
  );
  assert(!library.dependencies.effect, "Effect must be supplied by the consumer");
  assert.equal(library.peerDependencies.effect, "^3.22.2");
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      packageManager: manifest.packageManager,
      dependencies: {
        [library.name]: `file:${tarball}`,
        effect: manifest.devDependencies.effect,
        ai: manifest.devDependencies.ai,
        openai: manifest.devDependencies.openai,
        "@cloudflare/workers-types": manifest.devDependencies["@cloudflare/workers-types"],
      },
    }),
  );
  await writeFile(
    join(directory, "pnpm-workspace.yaml"),
    "autoInstallPeers: false\nminimumReleaseAge: 1440\nallowBuilds: {}\n",
  );
  run("pnpm", ["install", "--prefer-offline", "--ignore-scripts"], directory);
  await writeFile(
    join(directory, "consumer.ts"),
    `
import { Effect, Schema } from "effect";
import { type RuntimeDriver, runPromise } from "cf-open-agents-api";
import { createAgentService } from "cf-open-agents-api/cloudflare";
import { modelAdapter } from "cf-open-agents-api/models";
import { defineTool } from "cf-open-agents-api/tools";
const driver: RuntimeDriver = {
  name: "consumer", revision: "1", capabilities: { steer: false, functions: true, sandbox: false },
  start: () => Effect.void, control: () => Effect.void, stop: () => Effect.void,
  poll: () => Effect.succeed({ status: "completed", cursor: 0, events: [] }),
  checkpoint: () => Effect.succeed({ version: 1, driver: "consumer", revision: "1", native: "test" }),
};
void createAgentService;
void driver;
const adapter = modelAdapter(() => Effect.succeed(new Response("ok")));
const tool = defineTool({ name: "echo", description: "Consumer tool", input: Schema.Struct({ text: Schema.String }), output: Schema.String, effects: "read", retry: "safe", execute: ({ text }) => Effect.succeed(text) });
await runPromise(Effect.succeed(tool.spec));
await adapter.fetch(new Request("https://example.test"));
`,
  );
  await writeFile(
    join(directory, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2024",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        skipLibCheck: true,
        types: ["@cloudflare/workers-types"],
        noEmit: true,
      },
      files: ["consumer.ts"],
    }),
  );
  run(
    join(root, "node_modules/.bin/tsc"),
    ["--project", join(directory, "tsconfig.json")],
    directory,
  );
  await writeFile(
    join(directory, "runtime.mjs"),
    `
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { Effect } from "effect";
import { runPromise } from "cf-open-agents-api";
import { modelAdapter } from "cf-open-agents-api/models";
import { webSearch } from "cf-open-agents-api/tools";
const libraryRequire = createRequire(import.meta.resolve("cf-open-agents-api"));
assert.equal(libraryRequire.resolve("effect"), createRequire(import.meta.url).resolve("effect"));
assert.equal(await runPromise(Effect.succeed("shared")), "shared");
assert.equal(await (await modelAdapter(() => Effect.succeed(new Response("ok"))).fetch(new Request("https://example.test"))).text(), "ok");
assert.equal(webSearch(async () => []).spec.name, "web_search");
`,
  );
  run(process.execPath, ["runtime.mjs"], directory);
  console.log("Packed entrypoints, license files and a consumer-owned Effect driver passed.");
} finally {
  await rm(directory, { recursive: true, force: true });
}
