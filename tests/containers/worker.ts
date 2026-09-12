import { WorkerEntrypoint } from "cloudflare:workers";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import {
  type AgentBindings,
  CatalogObject,
  type ContainerBindings,
  ContainerProxy,
  containerHarnesses,
  createAgentService,
  createHarness,
  SandboxContainer,
} from "../../packages/agent-api/src/cloudflare.js";
import { aiSDKModel, createModelGateway } from "../../packages/agent-api/src/models.js";
import { installSkill, publishSkill } from "../../packages/agent-api/src/tools.js";

interface Bindings extends AgentBindings, ContainerBindings {}
const service = createAgentService<Bindings>({
  agents: {
    codex: { harness: "codex", model: "fixture" },
    "claude-code": { harness: "claude-code", model: "fixture" },
    opencode: { harness: "opencode", model: "fixture" },
  },
  harnesses: containerHarnesses,
  authenticate: async (request) =>
    request.headers.get("authorization") === "Bearer local-container-test" ? "local" : null,
  maxTurnMs: 120_000,
});
export class SessionDO extends service.SessionDO {}
export class TenantCatalogDO extends CatalogObject {}
const Harness = createHarness<Bindings>(async (sandbox, _execution, env) => {
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

/** Actual AI SDK model boundary; inference is scripted and makes no paid request. */
const gateway = createModelGateway(() => ({
  fixture: aiSDKModel(
    new MockLanguageModelV4({
      doStream: async ({ prompt, tools }) => {
        const lastUser = prompt.findLastIndex((message) => message.role === "user");
        const history = JSON.stringify(prompt);
        const restored = history.includes("verify-restored");
        if (restored && !history.includes("Container execution complete"))
          throw new Error("Missing native history");
        const toolResults = prompt.slice(lastUser + 1).filter((message) => message.role === "tool");
        const definitions = tools?.filter((tool) => tool.type === "function") ?? [];
        const codex = definitions.find((tool) => tool.name === "exec_command");
        const external = (name: string) =>
          definitions.find((tool) => tool.name === name || tool.name.endsWith(`__${name}`));
        const claude = definitions.some((tool) => tool.name.startsWith("mcp__"));
        const file = claude
          ? { file_path: "/workspace/proof.txt" }
          : { filePath: "/workspace/proof.txt" };
        const edit = claude
          ? { old_string: "before-edit", new_string: "sandbox-only" }
          : { oldString: "before-edit", newString: "sandbox-only" };
        const steps = codex
          ? [
              {
                name: codex.name,
                input: {
                  cmd: restored
                    ? "cat /workspace/proof.txt"
                    : "test -f /workspace/.agents/skills/smoke/SKILL.md && printf sandbox-only > /workspace/proof.txt && cat /workspace/proof.txt",
                  workdir: "/workspace",
                  max_output_tokens: 100,
                },
              },
            ]
          : restored
            ? [
                {
                  name: external("bash")?.name,
                  input: {
                    command: "cat /workspace/proof.txt",
                    description: "Read the restored proof",
                  },
                },
              ]
            : [
                { name: external("write")?.name, input: { ...file, content: "before-edit" } },
                { name: external("edit")?.name, input: { ...file, ...edit } },
                { name: external("read")?.name, input: { ...file } },
                {
                  name: external("bash")?.name,
                  input: {
                    command:
                      "test -f /workspace/.agents/skills/smoke/SKILL.md && cat /workspace/proof.txt",
                    description: "Verify the separate workspace",
                  },
                },
              ];
        const step = steps[toolResults.length];
        if (step && !step.name) throw new Error("Native workspace tool is missing");
        if (!step && !JSON.stringify(toolResults).includes("sandbox-only"))
          throw new Error(`Missing sandbox proof: ${JSON.stringify(toolResults)}`);
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              ...(step
                ? [
                    {
                      type: "tool-call" as const,
                      toolCallId: `call_${crypto.randomUUID().replaceAll("-", "")}`,
                      toolName: step.name ?? "missing-tool",
                      input: JSON.stringify(step.input),
                    },
                  ]
                : [
                    { type: "text-start" as const, id: "answer" },
                    {
                      type: "text-delta" as const,
                      id: "answer",
                      delta: restored
                        ? "Native history restored."
                        : "Container execution complete.",
                    },
                    { type: "text-end" as const, id: "answer" },
                  ]),
              {
                type: "finish",
                finishReason: { unified: step ? "tool-calls" : "stop", raw: undefined },
                usage: {
                  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
                  outputTokens: { total: 5, text: 5, reasoning: 0 },
                },
              },
            ],
          }),
        };
      },
    }),
  ),
}));
export class Models extends WorkerEntrypoint {
  override fetch(request: Request): Promise<Response> {
    return gateway.fetch(request, {});
  }
}
