import { expect, it } from "vitest";

import {
  isServerLabel,
  sanitizeServerLabel,
} from "../../packages/agent-api/src/portable-capabilities.js";

it("plugin-derived MCP labels are always valid server labels", () => {
  expect(sanitizeServerLabel("my-plugin_search")).toBe("my_plugin_search");
  expect(sanitizeServerLabel("9lives")).toBe("_9lives");
  expect(sanitizeServerLabel("a".repeat(100)).length).toBe(64);
  for (const candidate of ["日本語-plugin_tool", "", "-", "a b/c", "x".repeat(200)])
    expect(isServerLabel(sanitizeServerLabel(candidate)), candidate).toBe(true);
});

it("labels never collide with reserved or previously derived labels", () => {
  const taken = new Set(["fixture"]);
  expect(sanitizeServerLabel("fixture", taken)).toBe("fixture_2");
  taken.add("fixture_2");
  expect(sanitizeServerLabel("fixture", taken)).toBe("fixture_3");
  const long = "x".repeat(64);
  const distinct = sanitizeServerLabel(long, new Set([long]));
  expect(distinct.length).toBe(64);
  expect(distinct).not.toBe(long);
  expect(isServerLabel(distinct)).toBe(true);
});
