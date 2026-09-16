/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";

import { bearerTenant } from "../../packages/agent-api/src/service.js";

const authorized = { authorization: `Bearer ${env.API_TOKEN}` };

it("the destructured Agents entrypoint serves the API over its Service Binding", async () => {
  const response = await env.AGENTS.fetch(
    new Request("https://agents.internal/v1/agents/sessions", { headers: authorized }),
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ object: "list", data: [] });
});

it("the destructured Models entrypoint serves the registered gateway models", async () => {
  const gateway = (model: string) =>
    env.MODEL_GATEWAY.fetch(
      new Request("https://model.internal/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model }),
      }),
    );
  const known = await gateway("fixture-model");
  expect(known.status).toBe(200);
  expect(await known.json()).toEqual({ model: "fixture-model" });
  const missing = await gateway("absent");
  expect(missing.status).toBe(404);
  expect(await missing.json()).toMatchObject({ error: { type: "model_gateway_error" } });
});

it("bearerTenant rejects a short configured token and explains it once", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const request = new Request("https://agents.internal/v1", { headers: authorized });
    expect(await bearerTenant(request, "short", "default")).toBeNull();
    expect(await bearerTenant(request, undefined, "default")).toBeNull();
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]?.[0]).toContain("API_TOKEN");
    expect(await bearerTenant(request, env.API_TOKEN, "default")).toBe("default");
  } finally {
    error.mockRestore();
  }
});
