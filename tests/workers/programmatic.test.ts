/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from "cloudflare:test";
import { expect, it } from "vitest";

import { runProgrammatic } from "../../packages/agent-api/src/programmatic.js";

const loader = (env as unknown as { CODE_LOADER: WorkerLoader }).CODE_LOADER;
it("executes in a real isolated worker with only its allowed tool bridge", async () => {
  const calls: unknown[] = [];
  expect(
    await runProgrammatic(loader, {
      input: {
        code: "const values = await Promise.all([tools.lookup({id: 1}), tools.lookup({id: 2})]); return values.map(v => v.id * 2);",
      },
      tools: ["lookup"],
      call: async (name, args) => {
        calls.push({ name, args });
        return args;
      },
    }),
  ).toEqual([2, 4]);
  expect(calls).toHaveLength(2);
});

it("denies egress, unavailable tools and global state from preceding invocations", async () => {
  const run = (code: string) =>
    runProgrammatic(loader, {
      input: { code },
      tools: [],
      call: async () => {
        throw new Error("Unexpected tool call");
      },
    });
  expect(await run("globalThis.proof = 'private'; return 1;")).toBe(1);
  expect(await run("return globalThis.proof ?? null;")).toBeNull();
  await expect(run("return await fetch('https://example.com');")).rejects.toMatchObject({
    code: "programmatic_execution_failed",
  });
  await expect(run("return await tools.secret({});")).rejects.toMatchObject({
    code: "programmatic_execution_failed",
  });
  expect(await run("return typeof process === 'undefined' ? {} : process.env;")).toEqual({});
  await expect(run("return 'x'.repeat(256001);")).rejects.toMatchObject({
    code: "programmatic_execution_failed",
  });
  await expect(run("return '界'.repeat(90000);")).rejects.toMatchObject({
    code: "programmatic_execution_failed",
  });
});

it("bounds calls and revokes a bridge after timeout", async () => {
  let count = 0;
  await expect(
    runProgrammatic(loader, {
      input: { code: "for (let i = 0; i < 65; i++) await tools.lookup({});" },
      tools: ["lookup"],
      call: async () => {
        count++;
        return null;
      },
    }),
  ).rejects.toMatchObject({ code: "programmatic_execution_failed" });
  expect(count).toBe(64);
  let stopped = false;
  await expect(
    runProgrammatic(loader, {
      input: { code: "return await tools.lookup({});" },
      tools: ["lookup"],
      timeoutMs: 30,
      call: async (_name, _args, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              stopped = true;
              reject(new Error("aborted"));
            },
            { once: true },
          );
        }),
    }),
  ).rejects.toMatchObject({ code: "programmatic_execution_uncertain" });
  expect(stopped).toBe(true);
});

it("rejects swallowed callback failures because execution outcome is unknown", async () => {
  await expect(
    runProgrammatic(loader, {
      input: { code: "try { await tools.write({}); } catch {} return 'success';" },
      tools: ["write"],
      call: async () => {
        throw new Error("Response lost after write");
      },
    }),
  ).rejects.toMatchObject({ code: "programmatic_execution_uncertain" });
});
