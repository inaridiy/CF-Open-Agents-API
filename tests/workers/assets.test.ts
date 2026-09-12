/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, expect, it } from "vitest";
import { loadSkill, publishSkill, skillReader } from "../../packages/agent-api/src/tools.js";
import type { TestEnv } from "./worker.js";

declare global {
  namespace Cloudflare {
    interface Env extends TestEnv {}
  }
}
afterEach(() => reset());
it("publishes immutable skills and grants reads only through the deployment allowlist", async () => {
  const input = {
    name: "typescript",
    description: "TypeScript conventions",
    files: { "SKILL.md": "Use strict types.", "references/style.md": "Prefer composition." },
  };
  const reference = await publishSkill(env.ASSETS, input);
  expect(await publishSkill(env.ASSETS, input)).toEqual(reference);
  expect((await loadSkill(env.ASSETS, reference)).files["SKILL.md"]).toBe("Use strict types.");
  const reader = skillReader(env.ASSETS, { typescript: reference });
  const context = {
    tenantId: "tenant",
    sessionId: "session",
    operationId: "read",
    signal: new AbortController().signal,
  };
  expect(await reader.call({ name: "typescript" }, context)).toBe("Use strict types.");
  await expect(reader.call({ name: "other" }, context)).rejects.toMatchObject({
    code: "skill_missing",
  });
  await env.ASSETS.put(reference.key, JSON.stringify({ ...input, description: "tampered" }));
  await expect(loadSkill(env.ASSETS, reference)).rejects.toMatchObject({ code: "skill_integrity" });
});
it("rejects traversal before publishing any skill files", async () => {
  await expect(
    publishSkill(env.ASSETS, {
      name: "invalid",
      description: "bad paths",
      files: { "SKILL.md": "...", "../escape": "bad" },
    }),
  ).rejects.toMatchObject({ code: "invalid_skill_path" });
  expect((await env.ASSETS.list()).objects).toHaveLength(0);
});
