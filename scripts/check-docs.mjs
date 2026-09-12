import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
for (const command of Object.keys(manifest.scripts))
  assert(readme.includes(`pnpm ${command}`), `Document pnpm ${command} in README.md`);
const library = JSON.parse(
  await readFile(new URL("../packages/agent-api/package.json", import.meta.url), "utf8"),
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
for (const file of ["examples/worker/wrangler.jsonc", "tests/containers/wrangler.jsonc"]) {
  const config = JSON.parse(await readFile(new URL(`../${file}`, import.meta.url), "utf8"));
  assert.equal(
    config.services.find((service) => service.binding === "MODEL_GATEWAY").service,
    config.name,
    `${file}: the private model gateway must bind to its own Worker`,
  );
  assert.equal(
    config.vars.BACKUP_BUCKET_NAME,
    config.r2_buckets.find((bucket) => bucket.binding === "BACKUP_BUCKET").bucket_name,
    `${file}: sandbox backup configuration must match the R2 binding`,
  );
}
const dockerfile = await readFile(new URL("../docker/Sandbox.Dockerfile", import.meta.url), "utf8");
assert(
  dockerfile.includes(`cloudflare/sandbox:${library.dependencies["@cloudflare/sandbox"]}\n`),
  "Sandbox package and Docker image versions must match",
);
console.log("Project names, documented entrypoints, commands, bindings and image pins agree.");
