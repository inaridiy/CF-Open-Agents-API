import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/**
 * Publish the packages the "Version Packages" pull request just bumped, in the order the
 * setup CLI needs: tags first, packages second. `create-cf-open-agents-api`'s `vendor`
 * step downloads the `v<version>` archive of this repository, so that tag must exist on
 * GitHub before the CLI is installable. `changeset publish` would create and push the
 * per-package tags only after publishing, so this script creates every tag itself,
 * pushes them, and then publishes with `--no-git-tag`. A version already on npm is
 * skipped by `changeset publish`, so a rerun after a partial failure publishes what is
 * missing and moves no tag.
 */
/**
 * @param {string} path
 * @returns {{ name: string, version: string }}
 */
function manifest(path) {
  return /** @type {{ name: string, version: string }} */ (JSON.parse(readFileSync(path, "utf8")));
}
const { version } = manifest("packages/agent-api/package.json");
const cli = manifest("packages/create-cf-open-agents-api/package.json");
if (cli.version !== version) throw new Error(`Versions differ: ${version} and ${cli.version}`);
/**
 * @param {string} command
 * @param {readonly string[]} args
 */
const run = (command, args) => execFileSync(command, args, { stdio: "inherit" });
/** @param {string} name */
const published = (name) => {
  try {
    execFileSync("npm", ["view", `${name}@${version}`, "version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};
if (published("cf-open-agents-api") && published(cli.name)) {
  console.log(`${version} is already on npm; nothing to publish`);
  process.exit(0);
}
const tag = `v${version}`;
const tagged = () => {
  try {
    execFileSync("git", ["rev-parse", "--quiet", "--verify", `refs/tags/${tag}`], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
};
if (!tagged()) run("git", ["tag", "--annotate", tag, "--message", `Release ${version}`]);
run("pnpm", ["exec", "changeset", "git-tag"]);
run("git", ["push", "origin", "--tags"]);
run("pnpm", ["exec", "changeset", "publish", "--no-git-tag"]);
