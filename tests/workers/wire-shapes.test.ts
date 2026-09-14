/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { reset } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import OpenAI from "openai";
import { afterEach, expect, it } from "vitest";
import type { TestEnv } from "./worker.js";

declare global {
  namespace Cloudflare {
    interface Env extends TestEnv {}
    interface GlobalProps {
      mainModule: typeof import("./worker.js");
    }
  }
}

const tenant = "wire-shapes";
const api = new OpenAI({
  apiKey: tenant,
  baseURL: "https://api.test/v1",
  maxRetries: 0,
  fetch: (input, init) => exports.default.fetch(new Request(input, init)),
});
const none = { type: "none" as const };
const raw = (path: string, init: RequestInit = {}) =>
  exports.default.fetch(
    new Request(`https://api.test${path}`, {
      ...init,
      headers: { authorization: `Bearer ${tenant}`, ...(init.headers ?? {}) },
    }),
  );
const json = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  raw(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
afterEach(() => reset());

it("accepts vault_ids: null on create and fork as an empty list", async () => {
  const session = await api.beta.agents.sessions.create({
    agent: { model: "test" },
    environment: none,
    vault_ids: null,
  });
  expect(session.vault_ids).toEqual([]);
  const fork = await json(`/cf/v1/sessions/${session.id}/fork`, { vault_ids: null });
  expect(fork.status).toBe(200);
  expect(((await fork.json()) as { vault_ids: string[] }).vault_ids).toEqual([]);
});

it("treats an absent or empty request body as no changes instead of malformed JSON", async () => {
  const agent = await api.beta.agents.create({ model: "test", name: "bodyless" });
  const bare = await raw(`/v1/agents/${agent.id}`, { method: "POST" });
  expect(bare.status).toBe(200);
  expect(((await bare.json()) as { name: string }).name).toBe("bodyless");
  const empty = await raw(`/v1/agents/${agent.id}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "",
  });
  expect(empty.status).toBe(200);
  expect((await api.beta.agents.update(agent.id)).id).toBe(agent.id);
  const session = await api.beta.agents.sessions.create({
    agent: { model: "test" },
    environment: none,
  });
  expect((await api.beta.agents.sessions.update(session.id)).id).toBe(session.id);
  expect((await api.beta.agents.vaults.create()).object).toBe("vault");
  expect((await api.beta.agents.environments.templates.create()).object).toBe(
    "agent.environment.template",
  );
  // A body that is present but broken is still a client error.
  const broken = await raw(`/v1/agents/${agent.id}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not json",
  });
  expect(broken.status).toBe(400);
  expect(((await broken.json()) as { error: { code: string } }).error.code).toBe("invalid_json");
});

it("round-trips hyphenated function names and MCP server labels", async () => {
  const session = await api.beta.agents.sessions.create({
    agent: {
      model: "test-tools",
      tools: [
        { type: "function", name: "look-up_v2", description: "lookup", parameters: {} },
        {
          type: "mcp",
          server_label: "docs-server",
          transport: { type: "http", server_url: "https://mcp.example.test/" },
        },
      ],
    },
    environment: none,
  });
  expect(
    session.agent.tools.map((tool) =>
      tool.type === "function" ? tool.name : tool.type === "mcp" ? tool.server_label : tool.type,
    ),
  ).toEqual(["look-up_v2", "docs-server"]);
  const saved = await api.beta.agents.create({
    model: "test",
    tools: [{ type: "function", name: "saved-tool", description: "", parameters: {} }],
  });
  expect(saved.tools[0]).toMatchObject({ type: "function", name: "saved-tool" });
  expect((await api.beta.agents.retrieve(saved.id)).tools[0]).toMatchObject({ name: "saved-tool" });
  await expect(
    api.beta.agents.create({
      model: "test",
      tools: [{ type: "function", name: "spaces are invalid", description: "", parameters: {} }],
    }),
  ).rejects.toMatchObject({ status: 400 });
});

it("accepts every SDK file purpose and filters listings by it", async () => {
  const assistants = await api.files.create({
    file: new File([new Uint8Array([1, 2, 3])], "notes.txt"),
    purpose: "assistants",
  });
  expect(assistants.purpose).toBe("assistants");
  const evals = await api.files.create({
    file: new File([new Uint8Array([4])], "cases.jsonl"),
    purpose: "evals",
  });
  expect(evals.purpose).toBe("evals");
  expect((await api.files.list({ purpose: "assistants" })).data.map(({ id }) => id)).toEqual([
    assistants.id,
  ]);
  expect((await api.files.list({ purpose: "user_data" })).data).toEqual([]);
  expect((await api.files.list()).data.map(({ id }) => id).sort()).toEqual(
    [assistants.id, evals.id].sort(),
  );
  const rejected = await raw("/v1/files", {
    method: "POST",
    body: (() => {
      const form = new FormData();
      form.set("file", new File([new Uint8Array([9])], "x.bin"));
      form.set("purpose", "unknown_purpose");
      return form;
    })(),
  });
  expect(rejected.status).toBe(400);
});

it("marks permanent conflicts as not retryable and stamps every response with a request ID", async () => {
  const body = { agent: { model: "test" }, environment: none, input: "one" };
  const first = await json("/v1/agents/sessions", body, { "Idempotency-Key": "conflict-key" });
  expect(first.status).toBe(200);
  expect(first.headers.get("x-request-id")).toMatch(/^req_[0-9a-f]{32}$/);
  expect(first.headers.get("x-should-retry")).toBeNull();
  const conflict = await json(
    "/v1/agents/sessions",
    { ...body, input: "two" },
    { "Idempotency-Key": "conflict-key" },
  );
  expect(conflict.status).toBe(409);
  expect(((await conflict.json()) as { error: { code: string } }).error.code).toBe(
    "idempotency_conflict",
  );
  expect(conflict.headers.get("x-should-retry")).toBe("false");
  expect(conflict.headers.get("x-request-id")).toMatch(/^req_/);
  const unauthorized = await exports.default.fetch(
    new Request("https://api.test/v1/agents/sessions"),
  );
  expect(unauthorized.status).toBe(401);
  expect(unauthorized.headers.get("x-request-id")).toMatch(/^req_/);
  const { id } = (await first.json()) as { id: string };
  const stream = await raw(`/v1/agents/sessions/${id}/events`);
  expect(stream.headers.get("content-type")).toContain("text/event-stream");
  expect(stream.headers.get("x-request-id")).toMatch(/^req_/);
  await stream.body?.cancel();
});

it("caps distinct remote images per request at 256 and never counts data URLs", async () => {
  const image = (i: number) => ({
    type: "input_image" as const,
    image_url: `https://images.test/${i}.png`,
  });
  const messages = (count: number) => {
    const parts = Array.from({ length: count }, (_, i) => image(i));
    const result = [];
    for (let offset = 0; offset < parts.length; offset += 100)
      result.push({ role: "user" as const, content: parts.slice(offset, offset + 100) });
    return result;
  };
  await expect(
    api.beta.agents.sessions.create({
      agent: { model: "test-images" },
      environment: none,
      input: messages(257),
    }),
  ).rejects.toMatchObject({ status: 413, code: "image_limit" });
  const session = await api.beta.agents.sessions.create({
    agent: { model: "test-images" },
    environment: none,
  });
  await expect(
    api.beta.agents.sessions.events.create(session.id, {
      events: [{ type: "agent.session.input.message", input: messages(257) }],
    }),
  ).rejects.toMatchObject({ status: 413, code: "image_limit" });
  // Repeats of the same URL count once, and inline data URLs are not remote fetches.
  const pixel =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
  const okay = await api.beta.agents.sessions.create({
    agent: { model: "test-images" },
    environment: none,
    input: [
      ...messages(256),
      {
        role: "user",
        content: [
          ...Array.from({ length: 50 }, () => image(0)),
          ...Array.from({ length: 50 }, () => ({ type: "input_image" as const, image_url: pixel })),
        ],
      },
    ],
  });
  expect(okay.status).toBe("in_progress");
});

it("gates web_search on the alias's model connection as well as the harness", async () => {
  const session = await api.beta.agents.sessions.create({
    agent: { model: "test-search", tools: [{ type: "web_search" }] },
    environment: none,
  });
  expect(session.agent.tools[0]).toMatchObject({ type: "web_search", mode: "live" });
  await expect(
    api.beta.agents.sessions.create({
      agent: { model: "test-search-unflagged", tools: [{ type: "web_search" }] },
      environment: none,
    }),
  ).rejects.toMatchObject({ status: 422, code: "unsupported_capability" });
  const capabilities = (await (await raw("/cf/v1/capabilities")).json()) as {
    agents: Record<string, { webSearch?: boolean }>;
    harnesses: Record<string, { webSearch?: boolean }>;
  };
  expect(capabilities.agents["test-search"]?.webSearch).toBe(true);
  expect(capabilities.agents["test-search-unflagged"]?.webSearch).toBeUndefined();
  expect(capabilities.harnesses["fixture-search"]?.webSearch).toBe(true);
});

it("uses OpenAI's error types for rate limits and server errors", async () => {
  const session = await api.beta.agents.sessions.create({
    agent: { model: "test" },
    environment: none,
  });
  const streams = await Promise.all(
    Array.from({ length: 64 }, () => raw(`/v1/agents/sessions/${session.id}/events`)),
  );
  try {
    expect(streams.every((response) => response.status === 200)).toBe(true);
    const limited = await raw(`/v1/agents/sessions/${session.id}/events`);
    expect(limited.status).toBe(429);
    expect(
      ((await limited.json()) as { error: { type: string; code: string } }).error,
    ).toMatchObject({ type: "rate_limit_error", code: "stream_limit" });
  } finally {
    await Promise.all(streams.map((response) => response.body?.cancel()));
  }
  // The Service Binding fixture has no object storage, so a file upload is a server error.
  const form = new FormData();
  form.set("file", new File([new Uint8Array([1])], "x.bin"));
  form.set("purpose", "user_data");
  const unavailable = await env.AGENTS.fetch(
    new Request("https://agents.internal/v1/files", {
      method: "POST",
      headers: { authorization: `Bearer ${env.API_TOKEN}` },
      body: form,
    }),
  );
  expect(unavailable.status).toBe(503);
  expect(
    ((await unavailable.json()) as { error: { type: string; code: string } }).error,
  ).toMatchObject({ type: "server_error", code: "storage_unavailable" });
});
