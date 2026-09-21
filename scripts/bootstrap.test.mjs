import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { bootstrap } from "./bootstrap.mjs";

const repository = fileURLToPath(new URL("..", import.meta.url));

/**
 * A root holding the real `.dev.vars.example` templates, which bootstrap reads.
 * @param {import("node:test").TestContext} t
 */
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "cf-bootstrap-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const example of ["worker", "demo", "caller"]) {
    mkdirSync(join(root, "examples", example), { recursive: true });
    const template = join("examples", example, ".dev.vars.example");
    copyFileSync(join(repository, template), join(root, template));
  }
  return root;
}
/**
 * @param {string} root
 * @param {string} file
 */
const token = (root, file) =>
  /^API_TOKEN=(\S+)$/m.exec(readFileSync(join(root, file), "utf8"))?.[1];

void test("every example Worker gets the same fresh token", (t) => {
  const root = fixture(t);
  assert.deepEqual(
    bootstrap(root).map((result) => result.status),
    ["created", "created", "created"],
  );
  const worker = token(root, "examples/worker/.dev.vars");
  assert.ok(worker && worker.length >= 32);
  assert.equal(token(root, "examples/demo/.dev.vars"), worker);
  assert.equal(token(root, "examples/caller/.dev.vars"), worker);
});
void test("the rest of each file is that example's own template", (t) => {
  const root = fixture(t);
  bootstrap(root);
  for (const example of ["worker", "demo", "caller"]) {
    const written = readFileSync(join(root, "examples", example, ".dev.vars"), "utf8");
    const template = readFileSync(
      join(repository, "examples", example, ".dev.vars.example"),
      "utf8",
    );
    assert.equal(
      written.replace(/^API_TOKEN=.*$/m, ""),
      template.replace(/^API_TOKEN=.*$/m, ""),
      example,
    );
  }
  assert.match(readFileSync(join(root, "examples/worker/.dev.vars"), "utf8"), /LOCAL_BACKUPS=true/);
});
void test("existing files are kept unless forced", (t) => {
  const root = fixture(t);
  bootstrap(root);
  const first = token(root, "examples/worker/.dev.vars");
  assert.deepEqual(
    bootstrap(root).map((result) => result.status),
    ["skipped", "skipped", "skipped"],
  );
  assert.equal(token(root, "examples/worker/.dev.vars"), first);
  bootstrap(root, { force: true });
  assert.notEqual(token(root, "examples/worker/.dev.vars"), first);
});
