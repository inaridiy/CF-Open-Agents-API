import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
const manifest =
  /** @type {{ scripts: Record<string, string>, devDependencies: Record<string, string> }} */ (
    JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"))
  );
// npm lifecycle hooks run on install, and pre/post hooks of a documented script run with
// it; neither is a command a developer types.
const lifecycle = new Set(["prepare", "prepack", "postinstall", "preinstall", "prepublishOnly"]);
const isHook = (/** @type {string} */ command) => {
  const hook = /^(?:pre|post)(.+)$/.exec(command);
  return hook?.[1] !== undefined && hook[1] in manifest.scripts;
};
// A developer reads the README first and CONTRIBUTING for the rest; a command must be in one.
const contributing = await readFile(new URL("../CONTRIBUTING.md", import.meta.url), "utf8");
for (const command of Object.keys(manifest.scripts))
  if (!(lifecycle.has(command) || isHook(command)))
    assert(
      readme.includes(`pnpm ${command}`) || contributing.includes(`pnpm ${command}`),
      `Document pnpm ${command} in README.md or CONTRIBUTING.md`,
    );
const library =
  /** @type {{ name: string, repository: { url: string }, exports: Record<string, unknown>, dependencies: Record<string, string> }} */ (
    JSON.parse(
      await readFile(new URL("../packages/agent-api/package.json", import.meta.url), "utf8"),
    )
  );
const repositoryName = new URL(library.repository.url.replace(/^git\+/, "")).pathname
  .split("/")
  .at(-1)
  .replace(/\.git$/, "");
assert(readme.startsWith(`# ${repositoryName}\n`), "README title must match the repository name");
assert.equal(library.name, repositoryName.toLowerCase(), "Package name must match the project");
const packageReadme = await readFile(
  new URL("../packages/agent-api/README.md", import.meta.url),
  "utf8",
);
for (const entrypoint of Object.keys(library.exports)) {
  const specifier = library.name + (entrypoint === "." ? "" : entrypoint.slice(1));
  assert(packageReadme.includes(`\`${specifier}\``), `Document the ${specifier} entrypoint`);
}
for (const file of [
  "examples/worker/wrangler.jsonc",
  "examples/demo/wrangler.jsonc",
  "tests/containers/wrangler.jsonc",
]) {
  const config =
    /** @type {{ name: string, services: { binding: string, service: string }[], vars?: Record<string, string>, r2_buckets: { binding: string, bucket_name: string }[], containers: { class_name: string, name?: string, scheduling_policy?: string, images?: Record<string, { dockerfile?: string }>, image?: string, instance_type?: unknown, max_instances?: unknown }[] }} */ (
      JSON.parse(await readFile(new URL(`../${file}`, import.meta.url), "utf8"))
    );
  assert.equal(
    config.services.find((service) => service.binding === "MODEL_GATEWAY").service,
    config.name,
    `${file}: the private model gateway must bind to its own Worker`,
  );
  assert(
    config.r2_buckets.some((bucket) => bucket.binding === "BACKUP_BUCKET"),
    `${file}: DirectoryBackup needs the BACKUP_BUCKET binding`,
  );
  for (const [className, image] of [
    ["HarnessDO", "harness"],
    ["SandboxDO", "sandbox"],
  ]) {
    const entry = config.containers.find((container) => container.class_name === className);
    assert(entry, `${file}: ${className} needs a containers entry`);
    assert.equal(
      entry.scheduling_policy,
      "durable_object",
      `${file}: ${className} scheduling policy`,
    );
    assert(entry.name, `${file}: ${className} needs a container application name`);
    assert(entry.images?.[image]?.dockerfile, `${file}: ${className} needs the "${image}" image`);
    for (const key of ["image", "instance_type", "max_instances"])
      assert(!(key in entry), `${file}: ${className} keeps the default-policy key ${key}`);
  }
  assert(!config.vars?.BACKUP_BUCKET_NAME, `${file}: BACKUP_BUCKET_NAME is no longer read`);
}
const cli = /** @type {{ name: string, version: string, bin: Record<string, string> }} */ (
  JSON.parse(
    await readFile(
      new URL("../packages/create-cf-open-agents-api/package.json", import.meta.url),
      "utf8",
    ),
  )
);
assert.equal(cli.version, library.version, "The setup CLI and the library share one version");
assert.equal(cli.name, `create-${library.name}`, "The setup CLI is the library's create-* package");
const cliReadme = await readFile(
  new URL("../packages/create-cf-open-agents-api/README.md", import.meta.url),
  "utf8",
);
for (const command of ["init", "setup", "doctor", "vendor"])
  assert(
    new RegExp(`\`${command} \\[directory\\]`).test(cliReadme),
    `Document the ${command} command in the CLI README`,
  );
const dockerfile = await readFile(new URL("../docker/Sandbox.Dockerfile", import.meta.url), "utf8");
assert(
  dockerfile.includes(
    `COPY --from=docker.io/cloudflare/sandbox:${library.dependencies["@cloudflare/sandbox"]} /usr/local/bin/sandbox-shim`,
  ),
  "The sandbox-shim image tag must match the @cloudflare/sandbox version",
);
const supervisor = /** @type {{ dependencies: Record<string, string> }} */ (
  JSON.parse(
    await readFile(new URL("../packages/supervisor/package.json", import.meta.url), "utf8"),
  )
);
const harnessSource = await readFile(
  new URL("../packages/agent-api/src/harnesses.ts", import.meta.url),
  "utf8",
);
const harnessImage = await readFile(
  new URL("../docker/Harness.Dockerfile", import.meta.url),
  "utf8",
);
for (const [name, version] of [
  ["codex", /codex:\s*\{\s*revision: "([^"]+)"/.exec(harnessSource)?.[1]],
  ["opencode", supervisor.dependencies["@opencode-ai/sdk"]],
  ["claude-code", supervisor.dependencies["@anthropic-ai/claude-agent-sdk"]],
]) {
  assert(
    version && harnessSource.includes(`revision: "${version}"`),
    `${name}: checkpoint revision must match the native runtime`,
  );
  if (name === "codex") assert(harnessImage.includes(`@openai/codex@${version}`));
  if (name === "opencode") {
    assert(harnessImage.includes(`opencode-ai@${version}`));
    assert.equal(manifest.devDependencies["opencode-ai"], version);
  }
}
console.log("Project names, documented entrypoints, commands, bindings and image pins agree.");
