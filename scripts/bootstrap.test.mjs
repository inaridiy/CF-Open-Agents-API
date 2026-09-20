import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { bootstrap } from "./bootstrap.mjs";

/**
 * @param {import("node:test").TestContext} t
 */
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "cf-bootstrap-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const example of ["worker", "demo", "caller"])
    mkdirSync(join(root, "examples", example), { recursive: true });
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
