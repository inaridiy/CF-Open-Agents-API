import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = await mkdtemp(join(tmpdir(), "cf-package-consumer-"));
const manifest =
  /** @type {{ packageManager: string, devDependencies: Record<string, string> }} */ (
    JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"))
  );
const library =
  /** @type {{ name: string, version: string, dependencies: Record<string, string>, peerDependencies: Record<string, string> }} */ (
    JSON.parse(
      await readFile(new URL("../packages/agent-api/package.json", import.meta.url), "utf8"),
    )
  );
const cli = /** @type {{ name: string, version: string }} */ (
  JSON.parse(
    await readFile(
      new URL("../packages/create-cf-open-agents-api/package.json", import.meta.url),
      "utf8",
    ),
  )
);
/**
 * @param {string} command
 * @param {readonly string[]} args
 * @param {string} cwd
 */
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
  // The Cloudflare entrypoint composes the model gateway without the optional `ai` peer.
  for (const file of [
    "package/dist/cloudflare.js",
    "package/dist/worker.js",
    "package/dist/models/gateway.js",
  ]) {
    const source = execFileSync("tar", ["-xzOf", tarball, file], { encoding: "utf8" });
    assert(!/from "ai"/.test(source), `${file} must not import the optional ai peer`);
  }
  assert.equal(library.peerDependencies.effect, "^3.22.2");
  // The setup CLI ships on its own: an executable, no dependency on the library.
  run("pnpm", ["--filter", cli.name, "pack", "--pack-destination", directory], root);
  const cliTarball = join(directory, `${cli.name}-${cli.version}.tgz`);
  const cliEntries = execFileSync("tar", ["-tzf", cliTarball], { encoding: "utf8" }).split("\n");
  for (const file of [
    "LICENSE",
    "NOTICE",
    "CHANGELOG.md",
    "README.md",
    "dist/cli.js",
    "dist/index.js",
    "templates/demo/index.tsx",
    "templates/demo/ui.tsx",
    "templates/demo/README.md",
    "templates/rootless/dev-rootless.sh",
    "templates/rootless/netns-bridge.mjs",
  ])
    assert(cliEntries.includes(`package/${file}`), `Missing packaged CLI ${file}`);
  assert(
    !cliEntries.some((entry) => entry.startsWith("package/test/")),
    "CLI tests leaked into the package",
  );
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
      devDependencies: { [cli.name]: `file:${cliTarball}` },
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
import { type AgentRPC, createAgentService, defineAgentWorker } from "cf-open-agents-api/cloudflare";
import { modelAdapter } from "cf-open-agents-api/models";
import { defineTool } from "cf-open-agents-api/tools";
const driver: RuntimeDriver = {
  name: "consumer", revision: "1", capabilities: { steer: false, functions: true, sandbox: false },
  start: () => Effect.void, control: () => Effect.void, stop: () => Effect.void,
  poll: () => Effect.succeed({ status: "completed", cursor: 0, events: [] }),
  checkpoint: () => Effect.succeed({ version: 1, driver: "consumer", revision: "1", native: "test" }),
};
void createAgentService;
void defineAgentWorker;
declare const rpc: AgentRPC;
void rpc.listSessions("tenant");
void rpc.listItems("tenant", "sess_example", { limit: 1 });
void rpc.listTurns("tenant", "sess_example");
void rpc.retrieveTurn("tenant", "sess_example", "turn_example");
void rpc.deleteSession("tenant", "sess_example");
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
  // The packed CLI runs from node_modules and plans a retrofit of a fixture project.
  const fixture = join(directory, "fixture");
  await cp(
    new URL("../packages/create-cf-open-agents-api/test/fixtures/vite-project", import.meta.url),
    fixture,
    { recursive: true },
  );
  const planned = execFileSync(
    "pnpm",
    ["exec", cli.name, "init", "--yes", "--dry-run", "--source", root, fixture],
    {
      cwd: directory,
      encoding: "utf8",
      env: { ...process.env, CF_OPEN_AGENTS_API_SKIP_VENDOR: "1" },
    },
  );
  assert.match(planned, /Dry run: nothing was written/);
  assert.match(planned, /src\/agents\.ts/);
  // A new demo project reads templates/ from the tarball, not from the repository.
  const empty = join(directory, "empty");
  await mkdir(empty);
  const demo = execFileSync(
    "pnpm",
    [
      "exec",
      cli.name,
      "init",
      "--yes",
      "--dry-run",
      "--template",
      "demo",
      "--rootless",
      "--source",
      root,
      empty,
    ],
    {
      cwd: directory,
      encoding: "utf8",
      env: { ...process.env, CF_OPEN_AGENTS_API_SKIP_VENDOR: "1" },
    },
  );
  for (const file of ["src/index.tsx", "src/ui.tsx", "README.md", "scripts/dev-rootless.sh"])
    assert.match(demo, new RegExp(`- ${file.replace(/[./]/g, "\\$&")}`), `Planned ${file}`);
  console.log(
    "Packed entrypoints, license files, a consumer-owned Effect driver and the packed CLI passed.",
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
