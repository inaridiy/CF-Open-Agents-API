/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { abortAllDurableObjects, reset } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import OpenAI from "openai";
import { afterEach, expect, it } from "vitest";

const client = (tenant = "resources") =>
  new OpenAI({
    apiKey: tenant,
    baseURL: "https://api.test/v1",
    maxRetries: 0,
    fetch: (input, init) => exports.default.fetch(new Request(input, init)),
  });
afterEach(async () => {
  await reset();
});

it("updates saved agents without modifying existing session configuration", async () => {
  const api = client().beta.agents;
  const agent = await api.create({
    model: "test",
    name: "before",
    instructions: "original",
    reasoning: { effort: "high" },
    text: { verbosity: "low" },
  });
  const session = await api.sessions.create({ agent_id: agent.id, environment: { type: "none" } });
  expect(session.agent.reasoning.effort).toBe("high");
  const updated = await api.update(agent.id, {
    name: null,
    instructions: "replacement",
    metadata: { revision: "2" },
  });
  expect(updated.name).toBeNull();
  expect(updated.reasoning.effort).toBe("high");
  expect((await api.sessions.retrieve(session.id)).agent.instructions).toBe("original");
  await abortAllDurableObjects();
  expect((await api.retrieve(agent.id)).instructions).toBe("replacement");
  expect(
    (await api.sessions.create({ agent_id: agent.id, environment: { type: "none" } })).agent
      .instructions,
  ).toBe("replacement");
  await expect(
    client("other").beta.agents.update(agent.id, { name: "wrong" }),
  ).rejects.toMatchObject({ status: 404 });
});

it("persists template settings, redacts confidential bodies and pages with SDK cursors", async () => {
  const api = client().beta.agents.environments.templates;
  const first = await api.create({
    name: "one",
    env: { CONFIG: "private-environment-value" },
    setup_commands: [{ command: "private-setup-command" }],
    files: [{ type: "inline", path: "/workspace/input.txt", data: btoa("file-data") }],
    network: { access: "restricted", allowed_domains: ["example.com"] },
  });
  await api.create({ name: "two" });
  expect(JSON.stringify(first)).not.toMatch(/private-|ZmlsZS1kYXRh/);
  expect(first.files).toEqual([{ type: "inline", path: "/workspace/input.txt", size_bytes: 9 }]);
  expect((await api.update(first.id, { name: "renamed" })).network.access).toBe("restricted");
  await abortAllDurableObjects();
  expect((await api.retrieve(first.id)).name).toBe("renamed");
  const names: (string | null)[] = [];
  for await (const template of api.list({ limit: 1, order: "asc" })) names.push(template.name);
  expect(names).toEqual(["renamed", "two"]);
  await expect(
    client("other").beta.agents.environments.templates.retrieve(first.id),
  ).rejects.toMatchObject({ status: 404 });
  await api.delete(first.id);
  await expect(api.retrieve(first.id)).rejects.toMatchObject({ status: 404 });
});

it("session pagination keeps cursors inside the selected agent collection", async () => {
  const api = client().beta.agents;
  const a = await api.create({ model: "test" });
  const b = await api.create({ model: "test" });
  const first = await api.sessions.create({ agent_id: a.id, environment: { type: "none" } });
  const foreign = await api.sessions.create({ agent_id: b.id, environment: { type: "none" } });
  const last = await api.sessions.create({ agent_id: a.id, environment: { type: "none" } });
  const ids: string[] = [];
  for await (const session of api.sessions.list({ agent_id: a.id, limit: 1, order: "asc" }))
    ids.push(session.id);
  expect(ids).toEqual([first.id, last.id]);
  await expect(api.sessions.list({ agent_id: a.id, after: foreign.id })).rejects.toMatchObject({
    status: 400,
  });
});

it("vault credentials remain write-only through creation, rotation, restart and deletion", async () => {
  const api = client().beta.agents.vaults;
  const vault = await api.create({ name: "MCP" });
  const credential = await api.credentials.create(vault.id, {
    name: "OAuth",
    auth: {
      type: "mcp_oauth",
      mcp_server_url: "https://mcp.example.com/api",
      access_token: "secret-access",
      expires_at: "2030-01-01T00:00:00Z",
      refresh: {
        client_id: "client",
        refresh_token: "secret-refresh",
        token_endpoint: "https://auth.example.com/token",
        token_endpoint_auth: { type: "client_secret_basic", client_secret: "secret-client" },
      },
    },
  });
  expect(JSON.stringify(credential)).not.toContain("secret-");
  const rotated = await api.credentials.update(credential.id, {
    vault_id: vault.id,
    auth: { type: "mcp_oauth", access_token: "secret-replacement", refresh: { scope: "read" } },
  });
  expect(rotated.auth).toMatchObject({
    expires_at: null,
    refresh: { scope: "read", token_endpoint_auth: { type: "client_secret_basic" } },
  });
  await abortAllDurableObjects();
  expect(await api.credentials.retrieve(credential.id, { vault_id: vault.id })).toEqual(rotated);
  expect(JSON.stringify((await api.credentials.list(vault.id)).data)).not.toContain("secret-");
  await expect(
    client("other").beta.agents.vaults.credentials.retrieve(credential.id, { vault_id: vault.id }),
  ).rejects.toMatchObject({ status: 404 });
  await expect(
    api.credentials.update(credential.id, {
      vault_id: vault.id,
      auth: { type: "static_bearer", token: "bad-change" },
    }),
  ).rejects.toMatchObject({ status: 400 });
  await api.delete(vault.id);
  expect((await api.list()).data).toHaveLength(0);
  await expect(
    api.credentials.retrieve(credential.id, { vault_id: vault.id }),
  ).rejects.toMatchObject({ status: 404 });
});

it("stores Files API input bytes and restricts file IDs to their tenant after eviction", async () => {
  const api = client();
  const file = await api.files.create({
    file: new File([new Uint8Array([0, 255, 128, 10])], "binary.dat"),
    purpose: "user_data",
    expires_after: { anchor: "created_at", seconds: 3600 },
  });
  expect(file).toMatchObject({
    bytes: 4,
    filename: "binary.dat",
    purpose: "user_data",
    status: "processed",
  });
  await abortAllDurableObjects();
  expect(await api.files.retrieve(file.id)).toEqual(file);
  expect([...new Uint8Array(await (await api.files.content(file.id)).arrayBuffer())]).toEqual([
    0, 255, 128, 10,
  ]);
  expect((await api.files.list({ purpose: "user_data" })).data.map(({ id }) => id)).toEqual([
    file.id,
  ]);
  await expect(client("other").files.content(file.id)).rejects.toMatchObject({ status: 404 });
  await api.files.delete(file.id);
  await expect(api.files.retrieve(file.id)).rejects.toMatchObject({ status: 404 });
});
