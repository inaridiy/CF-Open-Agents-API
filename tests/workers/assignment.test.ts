/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { expect, it } from "vitest";

import { modelAllowed } from "../../packages/agent-api/src/containers/assignment.js";

it("admits the pinned model and every tier the assignment lists", () => {
  const assignment = { model: "gw-sonnet", tiers: { haiku: "gw-haiku", opus: "gw-opus" } };
  expect(modelAllowed(assignment, "gw-sonnet")).toBe(true);
  expect(modelAllowed(assignment, "gw-haiku")).toBe(true);
  expect(modelAllowed(assignment, "gw-opus")).toBe(true);
});

it("refuses a model the assignment never named, and a body without a model", () => {
  const assignment = { model: "gw-sonnet", tiers: { haiku: "gw-haiku" } };
  expect(modelAllowed(assignment, "gw-opus")).toBe(false);
  // The tier alias itself is resolved by the CLI; only gateway names reach the proxy.
  expect(modelAllowed(assignment, "haiku")).toBe(false);
  const body: { model?: unknown } = {};
  expect(modelAllowed(assignment, body.model)).toBe(false);
  expect(modelAllowed(assignment, 42)).toBe(false);
  // A missing tier falls back to `model`; it never admits the string "undefined".
  expect(modelAllowed({ model: "gw-sonnet", tiers: {} }, "undefined")).toBe(false);
});

it("without tiers only the pinned model is admitted", () => {
  expect(modelAllowed({ model: "gw-sonnet" }, "gw-sonnet")).toBe(true);
  expect(modelAllowed({ model: "gw-sonnet" }, "gw-haiku")).toBe(false);
});
