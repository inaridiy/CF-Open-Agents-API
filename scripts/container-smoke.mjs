import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import OpenAI from "openai";

// Run against tests/containers/wrangler.jsonc, never a production deployment.
const execute = promisify(execFile);
const pluginArchive = (
  await execute("python3", [
    "-c",
    `
import base64, io, json, zipfile
output = io.BytesIO()
with zipfile.ZipFile(output, 'w') as archive:
    archive.writestr('smoke-inline/.codex-plugin/plugin.json', json.dumps({'name': 'smoke-inline', 'description': 'Smoke inline plugin', 'version': '1.0.0', 'skills': './skills/'}))
    archive.writestr('smoke-inline/skills/catalog/SKILL.md', '---\\nname: inline-catalog\\ndescription: INLINE_PLUGIN_CATALOG_PROOF\\n---\\nUse the assigned workspace.\\n')
print(base64.b64encode(output.getvalue()).decode())
`,
  ])
).stdout.trim();
const config = JSON.parse(
  await readFile(new URL("../tests/containers/wrangler.jsonc", import.meta.url), "utf8"),
);
assert(config.name.endsWith("-container-test"), "Expected a dedicated Container test Worker");
const prefix = `workerd-${config.name}-`;
const docker = async (...args) => (await execute("docker", args)).stdout.trim();
const containers = async () =>
  (await docker("ps", "--all", "--filter", `name=${prefix}`, "--format", "{{.Names}}"))
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
async function complete(respondToTools = true) {
  for (let i = 0; i < 120; i++) {
    const session = await sessions.retrieve(sessionId);
    assert.notEqual(session.status, "failed", session.error ?? "Turn failed");
    if (session.status === "idle") return;
    if (respondToTools && session.required_actions.length) {
      await sessions.events.create(sessionId, {
        events: session.required_actions.map((action) => {
          assert.equal(action.type, "function_call");
          assert.equal(action.name, "lookup");
          return {
            type: "agent.session.input.tool_result",
            call_id: action.call_id,
            turn_id: action.turn_id,
            success: true,
            output: "CODE_TOOL_PROOF",
          };
        }),
      });
    }
    await delay(1_000);
  }
  throw new Error("Container smoke exceeded its 120 second turn deadline");
}
async function remember() {
  for (const name of await containers()) if (!before.has(name)) owned.add(name);
}
/** `/cf/v1` fork extension; the official SDK has no equivalent call. */
async function fork(id, body) {
  const response = await fetch(`http://127.0.0.1:8799/cf/v1/sessions/${id}/fork`, {
    method: "POST",
    headers: { authorization: "Bearer local-container-test", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return JSON.parse(text);
}
try {
  const vault = await api.beta.agents.vaults.create({ name: "MCP smoke" });
  await api.beta.agents.vaults.credentials.create(vault.id, {
    name: "scripted MCP",
    auth: {
      type: "static_bearer",
      mcp_server_url: "https://mcp.fixture/mcp",
      token: "fixture-mcp-token",
    },
  });
  // CF_SMOKE_HARNESSES narrows the iteration while diagnosing one runtime locally.
  const selected = (process.env.CF_SMOKE_HARNESSES ?? "codex,claude-code,opencode")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  for (const harnessName of ["codex", "claude-code", "opencode"].filter((name) =>
    selected.includes(name),
  )) {
    const iterationBefore = new Set([...owned, ...(await containers())]);
    // Every harness receives the same configured environment, saved skill, inline
    // plugin and service-origin MCP server with a Vault credential.
    const savedSkill = await api.skills.create({
      files: new File(
        [
          "---\nname: saved-smoke\ndescription: SAVED_SKILL_PIN_PROOF\n---\nUse the assigned workspace.\n",
        ],
        "SKILL.md",
      ),
    });
    const sourceFile = await api.files.create({
      file: new File(["configured-input"], "input.txt"),
      purpose: "user_data",
    });
    const session = await sessions.create({
      agent: {
        model: harnessName,
        tools: [
          { type: "programmatic_tool_calling" },
          {
            type: "function",
            name: "lookup",
            description: "Look up a scripted value",
            parameters: {
              type: "object",
              properties: { query: { type: "string" } },
              required: ["query"],
              additionalProperties: false,
            },
          },
          {
            type: "mcp",
            server_label: "fixture",
            transport: { type: "http", server_url: "https://mcp.fixture/mcp" },
            required: true,
            request_metadata: { fixture: true },
          },
        ],
      },
      vault_ids: [vault.id],
      environment: {
        type: "openai_hosted",
        env: { EXAMPLE_SETTING: "configured" },
        files: [{ type: "file_id", path: "/workspace/input.txt", file_id: sourceFile.id }],
        // The second command writes outside /workspace: the first turn must see it (the
        // provisioned sandbox is reused), and a restore after recovery must not.
        setup_commands: [
          {
            command:
              "cp /workspace/input.txt /workspace/setup.txt && printf HOME_SETUP > /tmp/cf-smoke-home.txt",
          },
        ],
        network: { access: "disabled" },
        skills: [{ type: "skill_reference", skill_id: savedSkill.id }],
        plugins: [
          {
            type: "inline",
            name: "smoke-inline",
            description: "Smoke inline plugin",
            source: { type: "base64", media_type: "application/zip", data: pluginArchive },
          },
        ],
      },
      input: "create-proof: write the sandbox proof.",
    });
    sessionId = session.id;
    await complete();
    await remember();
    const items = (await sessions.items.list(sessionId)).data;
    assert.equal(
      session.environment.skills.find((skill) => skill.type === "skill_reference")?.version,
      "1",
    );
    // The session pinned version 1; a newer default and deletion must not change it.
    await api.skills.versions.create(savedSkill.id, {
      files: new File(
        ["---\nname: saved-smoke\ndescription: WRONG_NEW_SKILL_VERSION\n---\nReplacement.\n"],
        "SKILL.md",
      ),
      default: true,
    });
    await api.skills.delete(savedSkill.id);
    assert(
      items.some(
        (item) =>
          item.type === "mcp_call" &&
          item.status === "completed" &&
          JSON.stringify(item.output).includes("MCP_LOOKUP_PROOF"),
      ),
      `Expected a completed MCP call for ${harnessName}`,
    );
    assert(!JSON.stringify(session).includes("fixture-mcp-token"));
    const artifacts = await sessions.artifacts.list(sessionId);
    assert.equal(artifacts.data.length, 1);
    assert.equal(
      await (
        await sessions.artifacts.content(artifacts.data[0].id, { session_id: sessionId })
      ).text(),
      "sandbox-only",
    );
    if (harnessName === "codex") {
      const files = [];
      for await (const file of api.beta.agents.environments.files.list(session.environment.id, {
        limit: 1,
      }))
        files.push(file);
      assert(files.some((file) => file.path === "/workspace/setup.txt"));
      const upload = await api.files.create({
        file: new File(["uploaded-after-checkpoint"], "追加.txt"),
        purpose: "user_data",
      });
      await api.beta.agents.environments.files.create(session.environment.id, {
        type: "file_id",
        path: "/workspace/uploaded.txt",
        file_id: upload.id,
      });
      for (const path of [
        "/workspace/一覧/a/file",
        "/workspace/一覧/a-b",
        "/workspace/一覧/界",
        "/workspace/一覧外/file",
      ])
        await api.beta.agents.environments.files.create(session.environment.id, {
          type: "inline",
          path,
          data: "AAH/",
        });
      const scoped = [];
      for await (const file of api.beta.agents.environments.files.list(session.environment.id, {
        path: "/workspace/一覧",
        order: "asc",
        limit: 1,
      }))
        scoped.push(file.path);
      assert.deepEqual(scoped, [
        "/workspace/一覧/a/file",
        "/workspace/一覧/a-b",
        "/workspace/一覧/界",
      ]);
    }
    assert(
      items.some(
        (item) =>
          item.type === "command_execution" &&
          item.exit_code === 0 &&
          item.output === "sandbox-only",
      ),
    );
    const harness = [...owned].find(
      (name) =>
        !iterationBefore.has(name) && name.includes("-HarnessDO-") && !name.endsWith("-proxy"),
    );
    const sandbox = [...owned].find(
      (name) =>
        !iterationBefore.has(name) && name.includes("-SandboxDO-") && !name.endsWith("-proxy"),
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
      `PASS: Worker → ${harnessName} Container → Sandbox Container; configured environment, pinned skill, MCP/Vault, artifact; R2 restore after destroying both containers.`,
    );
    await sessions.events.create(sessionId, {
      events: [
        {
          type: "agent.session.input.message",
          input: [{ role: "user", content: [{ type: "input_text", text: "programmatic-proof" }] }],
        },
      ],
    });
    await complete();
    const codeItems = (await sessions.items.list(sessionId, { limit: 100 })).data;
    assert(
      codeItems.some(
        (item) =>
          item.type === "message" &&
          JSON.stringify(item.content).includes("Code execution complete"),
      ),
    );
    assert.equal(
      codeItems.filter((item) => item.type === "function_call" && item.name === "lookup").length,
      2,
    );
    assert(!codeItems.some((item) => item.type === "function_call" && item.name === "cf_execute"));
    console.log(
      `PASS: ${harnessName} → Dynamic Worker → parallel client tool calls → native continuation.`,
    );
    await sessions.events.create(sessionId, {
      events: [
        {
          type: "agent.session.input.message",
          input: [
            { role: "user", content: [{ type: "input_text", text: "programmatic-proof-cancel" }] },
          ],
        },
      ],
    });
    let waiting;
    for (let attempt = 0; attempt < 30; attempt++) {
      waiting = await sessions.retrieve(sessionId);
      if (waiting.required_actions.length) break;
      assert.notEqual(waiting.status, "failed");
      await delay(1000);
    }
    assert(waiting.required_actions.length, "Expected pending code tool calls before cancelling");
    await sessions.events.create(sessionId, { events: [{ type: "agent.session.input.cancel" }] });
    await complete(false);
    assert.equal((await sessions.turns.list(sessionId)).data[0].status, "cancelled");
    // A cancelled turn discards the live sandbox: the next turn restores the committed
    // /workspace and nothing written outside it (the T2 marker) survives.
    await sessions.events.create(sessionId, {
      events: [
        {
          type: "agent.session.input.message",
          input: [{ role: "user", content: [{ type: "input_text", text: "verify-home-reset" }] }],
        },
      ],
    });
    await complete();
    assert(
      (await sessions.items.list(sessionId, { limit: 100 })).data.some(
        (item) =>
          item.type === "command_execution" && item.exit_code === 0 && item.output === "HOME_RESET",
      ),
      "Expected the sandbox to be restored from the checkpoint after cancellation",
    );
    console.log(
      `PASS: ${harnessName} reuses the provisioned/committed sandbox across completed turns and restores it after cancellation.`,
    );
    await sessions.events.create(sessionId, {
      events: [
        {
          type: "agent.session.input.message",
          input: [
            {
              role: "user",
              content: [{ type: "input_text", text: "programmatic-proof-abandoned" }],
            },
          ],
        },
      ],
    });
    let abandoned;
    for (let attempt = 0; attempt < 30; attempt++) {
      abandoned = await sessions.retrieve(sessionId);
      if (abandoned.status === "failed") break;
      await delay(1000);
    }
    assert.equal(abandoned.status, "failed", "Unawaited workspace effects must terminate the turn");
    assert.equal(abandoned.error, "programmatic_execution_uncertain");
    assert.equal(abandoned.required_actions.length, 0);
    console.log(
      `PASS: ${harnessName} terminates an abandoned workspace call with an explicit uncertain outcome.`,
    );
    // Recovery from the indeterminate session: fork its last committed checkpoint on the
    // same harness, enable subagents, and delegate a task to the next runtime.
    const next = { codex: "claude-code", "claude-code": "opencode", opencode: "codex" }[
      harnessName
    ];
    const recovered = await fork(sessionId, {
      agent: { multi_agent: { enabled: true, max_concurrent_subagents: 2 } },
      metadata: { recovered_from: sessionId },
    });
    assert.equal(recovered.status, "idle");
    assert.equal(recovered.agent.multi_agent.enabled, true);
    assert.notEqual(recovered.environment.id, session.environment.id);
    sessionId = recovered.id;
    await sessions.events.create(sessionId, {
      events: [
        {
          type: "agent.session.input.message",
          input: [{ role: "user", content: [{ type: "input_text", text: "delegate-proof" }] }],
        },
      ],
    });
    await complete();
    await remember();
    const subagents = (await sessions.subagents.list(sessionId)).data;
    assert.equal(subagents.length, 1, "Expected one delegated subagent");
    const child = subagents[0];
    assert.equal(child.status, "closed");
    assert.equal(child.name, "helper");
    assert(JSON.stringify(child.instructions).includes("child-proof"));
    const childTurns = (await sessions.subagents.turns.list(child.id, { session_id: sessionId }))
      .data;
    assert.equal(childTurns.length, 1);
    assert.equal(childTurns[0].status, "completed");
    const childItems = (await sessions.subagents.items.list(child.id, { session_id: sessionId }))
      .data;
    assert(
      childItems.some(
        (item) =>
          item.type === "command_execution" && item.exit_code === 0 && item.output === "CHILD_FILE",
      ),
      `Expected the ${next} child to run in the shared sandbox`,
    );
    assert(
      childItems.some(
        (item) => item.type === "message" && JSON.stringify(item.content).includes("CHILD_DONE"),
      ),
    );
    const parentItems = (await sessions.items.list(sessionId, { limit: 100 })).data;
    assert(parentItems.some((item) => item.type === "create_subagent_call"));
    assert(parentItems.some((item) => item.type === "wait_for_subagents_call"));
    assert(
      parentItems.some(
        (item) =>
          item.type === "message" && JSON.stringify(item.content).includes("Delegation complete"),
      ),
    );
    assert(
      !parentItems.some(
        (item) => item.type === "command_execution" && item.output === "CHILD_FILE",
      ),
    );
    await sessions.events.create(sessionId, {
      events: [
        {
          type: "agent.session.input.message",
          input: [{ role: "user", content: [{ type: "input_text", text: "verify-child-file" }] }],
        },
      ],
    });
    await complete();
    assert(
      (await sessions.items.list(sessionId, { limit: 100 })).data.some(
        (item) => item.type === "command_execution" && item.output === "CHILD_FILE",
      ),
      "The child's file must survive the parent's checkpoint",
    );
    console.log(
      `PASS: ${harnessName} fork recovers the committed workspace; ${harnessName} → ${next} delegation shares it.`,
    );
    // Portable-history fork: continue on the next runtime with the workspace and transcript.
    const ported = await fork(sessionId, {
      agent: { model: next, multi_agent: { enabled: false } },
    });
    assert.equal(ported.agent.model, next);
    sessionId = ported.id;
    await sessions.events.create(sessionId, {
      events: [
        {
          type: "agent.session.input.message",
          input: [
            {
              role: "user",
              content: [{ type: "input_text", text: "verify-ported: read the previous proof." }],
            },
          ],
        },
      ],
    });
    await complete();
    await remember();
    const portedItems = (await sessions.items.list(sessionId, { limit: 100 })).data;
    assert(
      portedItems.some(
        (item) =>
          item.type === "command_execution" &&
          item.exit_code === 0 &&
          item.output === "sandbox-only",
      ),
      `Expected ${next} to read the inherited workspace`,
    );
    assert(
      portedItems.some(
        (item) =>
          item.type === "message" &&
          item.role === "assistant" &&
          JSON.stringify(item.content).includes("Ported history restored"),
      ),
    );
    console.log(
      `PASS: ${harnessName} → ${next} portable-history fork continues in the inherited workspace.`,
    );
  }
  const searchSession = await sessions.create({
    agent: {
      model: "codex-search",
      tools: [{ type: "web_search", mode: "cached", allowed_domains: ["example.org"] }],
    },
    environment: { type: "none" },
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: "Check this image with cached search." },
          {
            type: "input_image",
            image_url:
              "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
          },
        ],
      },
    ],
  });
  sessionId = searchSession.id;
  await complete();
  await remember();
  assert.equal((await sessions.retrieve(sessionId)).usage?.total_tokens, 15);
  assert(
    (await sessions.items.list(sessionId)).data.some(
      (item) => item.type === "web_search_call" && item.status === "completed",
    ),
  );
  console.log(
    "PASS: official SDK → Codex Container → Worker model egress; cached search restrictions, image input and durable usage.",
  );
} catch (error) {
  await remember();
  for (const name of owned) {
    const logs = await execute("docker", ["logs", "--tail", "60", name]).catch(() => null);
    if (logs) console.error(`Container diagnostic: ${name}\n${logs.stdout}\n${logs.stderr}`);
  }
  throw error;
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
