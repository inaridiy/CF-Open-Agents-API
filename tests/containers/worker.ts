import { WorkerEntrypoint } from "cloudflare:workers";
import {
  type AgentBindings,
  CatalogObject,
  type ContainerBindings,
  ContainerProxy,
  codexDriver,
  createAgentService,
  createCodexHarness,
  SandboxContainer,
} from "../../packages/agent-api/src/cloudflare.js";
import { installSkill, publishSkill } from "../../packages/agent-api/src/tools.js";

interface Bindings extends AgentBindings, ContainerBindings {}
const service = createAgentService<Bindings>({
  models: { coding: { driver: "codex", model: "gpt-5.4" } },
  drivers: (env) => ({ codex: codexDriver(env) }),
  authenticate: async (request) =>
    request.headers.get("authorization") === "Bearer local-container-test" ? "local" : null,
  maxTurnMs: 120_000,
});
export class SessionDO extends service.SessionDO {}
export class TenantCatalogDO extends CatalogObject {}
const Harness = createCodexHarness<Bindings>(async (sandbox, _execution, env) => {
  const reference = await publishSkill(env.CHECKPOINTS, {
    name: "smoke",
    description: "Container smoke skill",
    files: { "SKILL.md": "Use the remote sandbox." },
  });
  await installSkill(env.CHECKPOINTS, reference, sandbox);
});

export { Harness as HarnessDO };
export class SandboxDO extends SandboxContainer {}
export { ContainerProxy };
export default class AgentWorker extends service.AgentWorker {}

/** Local protocol fixture. No external network request or API key is used. */
export class Models extends WorkerEntrypoint {
  override async fetch(request: Request): Promise<Response> {
    const body = await request.json<{
      input: { type: string; role?: string; output?: unknown }[];
      tools: { name?: string }[];
    }>();
    const lastInput = body.input.findLastIndex(
      (item) => item.type === "message" && item.role === "user",
    );
    const outputs = body.input
      .slice(lastInput + 1)
      .filter((item) => item.type === "function_call_output");
    const restore = JSON.stringify(body.input).includes("verify-restored");
    if (!body.tools.some((tool) => tool.name === "exec_command"))
      return new Response("Native exec_command is missing", { status: 500 });
    const id = `step_${lastInput}`;
    const item = outputs.length
      ? {
          type: "message",
          id: `msg_${id}`,
          role: "assistant",
          status: "completed",
          content: [
            {
              type: "output_text",
              text: restore ? "Native history restored." : "Container execution complete.",
            },
          ],
        }
      : {
          type: "function_call",
          id: `fc_${id}`,
          call_id: `call_${id}`,
          name: "exec_command",
          arguments: JSON.stringify({
            cmd: restore
              ? "cat /workspace/proof.txt"
              : "test -f /workspace/.agents/skills/smoke/SKILL.md && printf sandbox-only > /workspace/proof.txt && cat /workspace/proof.txt",
            workdir: "/workspace",
            max_output_tokens: 100,
          }),
        };
    const events = [
      {
        type: "response.created",
        response: { id: "resp_local", object: "response", status: "in_progress", output: [] },
      },
      { type: "response.output_item.done", output_index: 0, item },
      {
        type: "response.completed",
        response: {
          id: "resp_local",
          object: "response",
          status: "completed",
          output: [item],
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        },
      },
    ];
    return new Response(
      events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
      { headers: { "content-type": "text/event-stream" } },
    );
  }
}
