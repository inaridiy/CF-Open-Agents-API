/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { abortAllDurableObjects, reset, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { Effect, Exit, Fiber } from "effect";
import { afterEach, expect, it } from "vitest";

import { runPromise, runSync } from "../../packages/agent-api/src/effect.js";
import { copyKnownLength, uploadInputFile } from "../../packages/agent-api/src/files.js";
import { proxyMcp } from "../../packages/agent-api/src/mcp.js";
import { nativeModel } from "../../packages/agent-api/src/models.js";
import type { Execution } from "../../packages/agent-api/src/runtime.js";
import { fromPromiseDriver } from "../../packages/agent-api/src/runtime.js";
import { VaultRepository } from "../../packages/agent-api/src/vaults.js";
import type { CatalogDO, TestEnv } from "./worker.js";

declare global {
  namespace Cloudflare {
    interface Env extends TestEnv {}
  }
}
afterEach(() => reset());

it("native requests work in workerd and reject redirects before forwarding provider credentials", async () => {
  let calls = 0;
  let discarded = false;
  const model = nativeModel({
    protocol: "responses",
    baseURL: "https://provider.test/v1",
    model: "native",
    apiKey: "provider-token",
    fetch: async (input, init) => {
      const request = new Request(input, init);
      calls++;
      expect(request.redirect).toBe("manual");
      expect(request.headers.get("authorization")).toBe("Bearer provider-token");
      expect(request.headers.get("cookie")).toBeNull();
      expect(await request.json()).toMatchObject({ model: "native", opaque: "preserved" });
      return calls === 1
        ? Response.json({ opaque: "response" })
        : new Response(
            new ReadableStream({
              cancel: () => {
                discarded = true;
              },
            }),
            { status: 307, headers: { location: "https://unconfigured.test" } },
          );
    },
  });
  const request = () =>
    new Request("https://model.internal/v1/responses", {
      method: "POST",
      headers: { authorization: "Bearer caller", cookie: "private" },
      body: JSON.stringify({ model: "alias", opaque: "preserved" }),
    });
  expect(await (await model.fetch(request())).json()).toEqual({ opaque: "response" });
  await expect(model.fetch(request())).rejects.toMatchObject({ code: "upstream_redirect" });
  expect(calls).toBe(2);
  expect(discarded).toBe(true);
});

it("MCP injects only configured credentials and metadata into a fixed destination", async () => {
  const result = await runPromise(
    proxyMcp(
      new Request("http://mcp.internal/docs", {
        method: "POST",
        headers: { authorization: "Bearer caller", cookie: "private", "mcp-session-id": "session" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "lookup", _meta: { trace: "kept", tenant: "caller" } },
        }),
      }),
      {
        type: "mcp",
        server_label: "docs",
        transport: {
          type: "http",
          server_url: "https://mcp.test/rpc",
          headers: { "x-configured": "yes" },
        },
        request_metadata: { tenant: "configured" },
      },
      "vault-token",
      async (request) => {
        expect(request.url).toBe("https://mcp.test/rpc");
        expect(request.redirect).toBe("manual");
        expect(request.headers.get("authorization")).toBe("Bearer vault-token");
        expect(request.headers.get("cookie")).toBeNull();
        expect(request.headers.get("mcp-session-id")).toBe("session");
        expect(request.headers.get("x-configured")).toBe("yes");
        expect(await request.json()).toMatchObject({
          params: { _meta: { trace: "kept", tenant: "configured" } },
        });
        return Response.json({ result: "ok" });
      },
    ),
  );
  expect(await result.json()).toEqual({ result: "ok" });
});

it("R2 transfer interrupts a live producer when storage rejects the write", async () => {
  const cancelled = Promise.withResolvers<void>();
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1]));
    },
    cancel() {
      cancelled.resolve();
    },
  });
  await expect(
    runPromise(
      copyKnownLength(source, 2, async () => {
        throw new Error("R2 unavailable");
      }),
    ),
  ).rejects.toMatchObject({ operation: "file.transfer.store" });
  await cancelled.promise;
});

it("R2 transfer preserves binary bytes and never publishes a truncated producer", async () => {
  const bytes = new Uint8Array([0, 255, 128, 65]);
  await runPromise(
    copyKnownLength(new Blob([bytes]).stream(), bytes.length, (stream) =>
      env.ASSETS.put("complete", stream),
    ),
  );
  const stored = await env.ASSETS.get("complete");
  if (!stored) throw new Error("Completed transfer was not stored");
  expect(new Uint8Array(await stored.arrayBuffer())).toEqual(bytes);
  await expect(
    runPromise(
      copyKnownLength(new Blob([bytes]).stream(), bytes.length + 1, (stream) =>
        env.ASSETS.put("truncated", stream),
      ),
    ),
  ).rejects.toBeDefined();
  expect(await env.ASSETS.head("truncated")).toBeNull();
});

const serverURL = "https://mcp.test/rpc";
const expiredAuth = {
  type: "mcp_oauth" as const,
  mcp_server_url: serverURL,
  access_token: "expired",
  expires_at: "2000-01-01T00:00:00Z",
  refresh: {
    client_id: "client space",
    refresh_token: "refresh-token",
    token_endpoint: "https://auth.test/token",
    token_endpoint_auth: { type: "client_secret_basic" as const, client_secret: "client:secret" },
  },
};

it("concurrent OAuth callers share one refresh and reuse its durable result after eviction", async () => {
  const stub = env.CATALOG.getByName("oauth-concurrency");
  const result = await runInDurableObject<CatalogDO, { vault: string; credential: string }>(
    stub,
    async (instance) => {
      let calls = 0;
      const entered = Promise.withResolvers<void>();
      const response = Promise.withResolvers<Response>();
      const repository = new VaultRepository(instance.db, async (request) => {
        calls++;
        expect(request.redirect).toBe("manual");
        expect(request.headers.get("authorization")).toBe(
          `Basic ${btoa("client+space:client%3Asecret")}`,
        );
        expect((await request.formData()).get("refresh_token")).toBe("refresh-token");
        entered.resolve();
        return response.promise;
      });
      const vault = repository.create({});
      const credential = repository.createCredential(vault.id, {
        name: "OAuth",
        auth: expiredAuth,
      });
      const first = runPromise(repository.token([vault.id], serverURL));
      await entered.promise;
      const second = runPromise(repository.token([vault.id], serverURL));
      response.resolve(
        Response.json({
          access_token: "renewed",
          token_type: "Bearer",
          expires_in: 3600,
          refresh_token: "rotated-refresh",
        }),
      );
      expect(await Promise.all([first, second])).toEqual(["renewed", "renewed"]);
      expect(calls).toBe(1);
      expect(JSON.stringify(repository.credential(vault.id, credential.id))).not.toContain(
        "renewed",
      );
      return { vault: vault.id, credential: credential.id };
    },
  );
  await abortAllDurableObjects();
  expect(
    await env.CATALOG.getByName("oauth-concurrency").mcpToken(
      [result.vault],
      serverURL,
      result.credential,
    ),
  ).toBe("renewed");
});

it("OAuth interruption aborts the request and preserves unknown outcome across eviction until rotation", async () => {
  const stub = env.CATALOG.getByName("oauth-interrupted");
  const result = await runInDurableObject<CatalogDO, { vault: string; credential: string }>(
    stub,
    async (instance) => {
      const entered = Promise.withResolvers<void>();
      const aborted = Promise.withResolvers<void>();
      const repository = new VaultRepository(
        instance.db,
        (request) =>
          new Promise<Response>((_resolve, reject) => {
            request.signal.addEventListener(
              "abort",
              () => {
                aborted.resolve();
                reject(request.signal.reason as Error);
              },
              { once: true },
            );
            entered.resolve();
          }),
      );
      const vault = repository.create({});
      const credential = repository.createCredential(vault.id, {
        name: "OAuth",
        auth: expiredAuth,
      });
      const fiber = Effect.runFork(repository.token([vault.id], serverURL));
      await entered.promise;
      await runPromise(Fiber.interrupt(fiber));
      await aborted.promise;
      return { vault: vault.id, credential: credential.id };
    },
  );
  await abortAllDurableObjects();
  const restored = env.CATALOG.getByName("oauth-interrupted");
  await expect(Promise.resolve(restored.mcpToken([result.vault], serverURL))).rejects.toMatchObject(
    {
      name: "AgentApiError:409:outcome_unknown",
    },
  );
  await restored.rotateCredential(result.vault, result.credential, {
    auth: { type: "mcp_oauth", access_token: "manual-rotation" },
  });
  expect(await restored.mcpToken([result.vault], serverURL)).toBe("manual-rotation");
});

it("a late OAuth response cannot overwrite a manual rotation, even back to the same token", async () => {
  await runInDurableObject<CatalogDO, void>(
    env.CATALOG.getByName("oauth-rotation"),
    async (instance) => {
      const entered = Promise.withResolvers<void>();
      const response = Promise.withResolvers<Response>();
      const repository = new VaultRepository(instance.db, () => {
        entered.resolve();
        return response.promise;
      });
      const vault = repository.create({});
      const credential = repository.createCredential(vault.id, {
        name: "OAuth",
        auth: expiredAuth,
      });
      const refresh = runPromise(repository.token([vault.id], serverURL));
      await entered.promise;
      repository.rotate(vault.id, credential.id, {
        auth: {
          type: "mcp_oauth",
          access_token: expiredAuth.access_token,
          expires_at: expiredAuth.expires_at,
        },
      });
      response.resolve(
        Response.json({ access_token: "stale-response", token_type: "Bearer", expires_in: 3600 }),
      );
      await expect(refresh).rejects.toMatchObject({ code: "credential_changed" });
      repository.rotate(vault.id, credential.id, {
        auth: { type: "mcp_oauth", access_token: "current" },
      });
      expect(await runPromise(repository.token([vault.id], serverURL))).toBe("current");
    },
  );
});

const execution: Execution = {
  sessionId: "sess_interrupt",
  turnId: "turn_interrupt",
  generation: 1,
  harness: "fixture",
  model: "fixture-model",
  agent: { model: "test" },
  input: [],
  checkpoint: null,
  deadline: Date.now() + 60_000,
  sandbox: false,
};

it("interrupting a fiber mid-driver call aborts the underlying Promise through io's signal", async () => {
  const entered = Promise.withResolvers<void>();
  const aborted = Promise.withResolvers<unknown>();
  const driver = fromPromiseDriver({
    name: "fixture",
    revision: "test-v1",
    capabilities: { steer: true, functions: true, sandbox: false },
    start: async () => {},
    stop: async () => {},
    control: async () => {},
    checkpoint: async () => ({ version: 1, driver: "fixture", revision: "test-v1", native: "x" }),
    // A poll that only ends when the fiber's interruption reaches it, like a containerFetch.
    poll: (_execution, _after, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            aborted.resolve(signal.reason);
            reject(signal.reason as Error);
          },
          { once: true },
        );
        entered.resolve();
      }),
  });
  const fiber = Effect.runFork(driver.poll(execution, 0));
  await entered.promise;
  const exit = await runPromise(Fiber.interrupt(fiber));
  expect(Exit.isInterrupted(exit)).toBe(true);
  expect(await aborted.promise).toBeInstanceOf(Error);
});

it("an uninterruptible R2 write completes before its interrupted fiber stops", async () => {
  const entered = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  let key: string | undefined;
  const bucket = {
    put: async (name: string, body: ReadableStream, options?: R2PutOptions) => {
      key = name;
      entered.resolve();
      await gate.promise;
      return env.ASSETS.put(name, body, options);
    },
  } as unknown as R2Bucket;
  const form = new FormData();
  form.set("file", new File(["durable bytes"], "note.txt", { type: "text/plain" }));
  form.set("purpose", "user_data");
  const fiber = Effect.runFork(uploadInputFile(bucket, form));
  await entered.promise;
  let settled = false;
  const interrupted = runPromise(Fiber.interrupt(fiber)).then((exit) => {
    settled = true;
    return exit;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  // The interrupt is queued behind the put; the fiber has not stopped yet.
  expect(settled).toBe(false);
  gate.resolve();
  const exit = await interrupted;
  expect(Exit.isInterrupted(exit)).toBe(true);
  if (!key) throw new Error("The write never started");
  expect(await (await env.ASSETS.get(key))?.text()).toBe("durable bytes");
});

it("runSync refuses to run an effect that suspends and names the operation", () => {
  expect(runSync(Effect.succeed(1))).toBe(1);
  expect(() =>
    runSync(
      Effect.promise(() => Promise.resolve(1)),
      "test.async",
    ),
  ).toThrow(/test\.async ran an asynchronous effect/);
});
