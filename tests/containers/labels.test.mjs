import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isServerLabel,
  sanitizeServerLabel,
} from "../../packages/agent-api/dist/portable-capabilities.js";

// Run after `pnpm build`: node --test tests/containers/labels.test.mjs

test("plugin-derived MCP labels are always valid server labels", () => {
  assert.equal(sanitizeServerLabel("my-plugin_search"), "my_plugin_search");
  assert.equal(sanitizeServerLabel("9lives"), "_9lives");
  assert.equal(sanitizeServerLabel("a".repeat(100)).length, 64);
  for (const candidate of ["日本語-plugin_tool", "", "-", "a b/c", "x".repeat(200)])
    assert.ok(isServerLabel(sanitizeServerLabel(candidate)), candidate);
});

test("labels never collide with reserved or previously derived labels", () => {
  const taken = new Set(["fixture"]);
  assert.equal(sanitizeServerLabel("fixture", taken), "fixture_2");
  taken.add("fixture_2");
  assert.equal(sanitizeServerLabel("fixture", taken), "fixture_3");
  const long = "x".repeat(64);
  const distinct = sanitizeServerLabel(long, new Set([long]));
  assert.equal(distinct.length, 64);
  assert.notEqual(distinct, long);
  assert.ok(isServerLabel(distinct));
});
