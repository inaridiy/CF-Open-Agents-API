import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import OpenAI from "openai";

// Run against tests/containers/wrangler.jsonc, never a production deployment.
const execute = promisify(execFile);
const config = JSON.parse(
  await readFile(new URL("../tests/containers/wrangler.jsonc", import.meta.url), "utf8"),
);
assert(config.name.endsWith("-container-test"), "Expected a dedicated Container test Worker");
const prefix = `workerd-${config.name}-`;
const docker = async (...args) => (await execute("docker", args)).stdout.trim();
const containers = async () =>
  (await docker("ps", "--filter", `name=${prefix}`, "--format", "{{.Names}}"))
    .split("\n")
    .filter(Boolean);
const before = new Set(await containers());
const api = new OpenAI({
  apiKey: "local-container-test",
  baseURL: "http://127.0.0.1:8799/v1",
  maxRetries: 0,
});
const sessions = api.beta.agents.sessions;
let sessionId;
const owned = new Set();
async function complete() {
  for (let i = 0; i < 120; i++) {
    const session = await sessions.retrieve(sessionId);
    assert.notEqual(session.status, "failed", session.error ?? "Turn failed");
    if (session.status === "idle") return;
    await delay(1_000);
  }
  throw new Error("Container smoke exceeded its 120 second turn deadline");
}
async function remember() {
  for (const name of await containers()) if (!before.has(name)) owned.add(name);
}
try {
  const session = await sessions.create({
    agent: { model: "coding" },
    environment: { type: "openai_hosted" },
    input: "create-proof: write the sandbox proof.",
  });
  sessionId = session.id;
  await complete();
  await remember();
  const items = (await sessions.items.list(sessionId)).data;
  assert(
    items.some(
      (item) =>
        item.type === "command_execution" && item.exit_code === 0 && item.output === "sandbox-only",
    ),
  );
  const harness = [...owned].find(
    (name) => name.includes("-HarnessDO-") && !name.endsWith("-proxy"),
  );
  const sandbox = [...owned].find(
    (name) => name.includes("-SandboxDO-") && !name.endsWith("-proxy"),
  );
  assert(harness && sandbox, "Expected two distinct runtime containers");
  await docker("exec", harness, "test", "!", "-e", "/workspace/proof.txt");
  assert.equal(await docker("exec", sandbox, "cat", "/workspace/proof.txt"), "sandbox-only");
  // Destroy compute after checkpoint commit. The next turn must restore from R2.
  await docker("rm", "--force", harness, sandbox);
  await sessions.events.create(sessionId, {
    events: [
      {
        type: "agent.session.input.message",
        input: [
          {
            role: "user",
            content: [{ type: "input_text", text: "verify-restored: read the previous proof." }],
          },
        ],
      },
    ],
  });
  await complete();
  await remember();
  const resumed = (await sessions.items.list(sessionId, { limit: 100 })).data;
  const commands = resumed.filter((item) => item.type === "command_execution");
  assert.equal(commands.length, 2);
  assert(commands.every((item) => item.exit_code === 0 && item.output === "sandbox-only"));
  assert(
    resumed.some(
      (item) =>
        item.type === "message" &&
        item.role === "assistant" &&
        JSON.stringify(item.content).includes("Native history restored"),
    ),
  );
  assert.equal(
    (await sessions.turns.list(sessionId)).data.filter((turn) => turn.status === "completed")
      .length,
    2,
  );
  console.log(
    "PASS: Worker → Codex Container → sandbox Container; native command isolation; R2 restore after destroying both containers.",
  );
} finally {
  await remember();
  if (sessionId) {
    const session = await sessions.retrieve(sessionId);
    if (session.status !== "idle" && session.status !== "failed")
      await sessions.events.create(sessionId, { events: [{ type: "agent.session.input.cancel" }] });
  }
  // Only names created by this smoke process are eligible for removal.
  for (const name of owned) await docker("rm", "--force", name).catch(() => {});
}
