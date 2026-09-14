import { WorkerEntrypoint } from "cloudflare:workers";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import {
  type AgentBindings,
  CatalogObject,
  type ContainerBindings,
  ContainerProxy,
  containerEnvironments,
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
    codex: { harness: "codex", model: "fixture", delegates: ["claude-code"] },
    "codex-search": { harness: "codex", model: "search-fixture", webSearch: true },
    "claude-code": { harness: "claude-code", model: "fixture", delegates: ["opencode"] },
    opencode: { harness: "opencode", model: "fixture", delegates: ["codex"] },
  },
  harnesses: containerHarnesses,
  objects: (env) => env.CHECKPOINTS,
  environments: containerEnvironments,
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
      doStream: async (options) => {
        try {
          return await scripted(options);
        } catch (error) {
          // The gateway reports a generic failure to the runtime; keep the scripted reason visible.
          console.error("Scripted model rejected the request", {
            reason: String(error),
            prompt: JSON.stringify(options.prompt).slice(-4000),
          });
          throw error;
        }
      },
    }),
  ),
}));
type StreamOptions = Parameters<NonNullable<MockLanguageModelV4["doStream"]>>[0];
type StreamResult = Awaited<ReturnType<MockLanguageModelV4["doStream"]>>;
async function scripted({ prompt, tools }: StreamOptions): Promise<StreamResult> {
  {
    const lastUser = prompt.findLastIndex((message) => message.role === "user");
    const history = JSON.stringify(prompt);
    // A forked session's first turn carries the source transcript ahead of the request.
    const request = JSON.stringify(prompt[lastUser]).split("</transcript>").at(-1) ?? "";
    const restored = history.includes("verify-restored");
    if (restored && !history.includes("Container execution complete"))
      throw new Error("Missing native history");
    const toolResults = prompt.slice(lastUser + 1).filter((message) => message.role === "tool");
    const definitions = tools?.filter((tool) => tool.type === "function") ?? [];
    if (request.includes("programmatic-proof")) {
      const abandoned = request.includes("programmatic-proof-abandoned");
      // The code also proves the sandbox of the previous completed turn was reused: the
      // marker it wrote outside /workspace is still there.
      const received =
        JSON.stringify(toolResults).includes("CODE_TOOL_PROOF") &&
        (request.includes("programmatic-proof-cancel") ||
          JSON.stringify(toolResults).includes("T2_KEPT"));
      const codeTool = definitions.find(
        (tool) =>
          tool.name === "cf_execute" ||
          tool.name.endsWith("__cf_execute") ||
          tool.name === "workspace_cf_execute",
      );
      if (!codeTool) throw new Error("Programmatic tool was not exposed");
      if (toolResults.length && !received && !abandoned)
        throw new Error(`Programmatic execution failed: ${JSON.stringify(toolResults)}`);
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            ...(received
              ? [
                  { type: "text-start" as const, id: "code-answer" },
                  {
                    type: "text-delta" as const,
                    id: "code-answer",
                    delta: "Code execution complete",
                  },
                  { type: "text-end" as const, id: "code-answer" },
                ]
              : [
                  {
                    type: "tool-call" as const,
                    toolCallId: `call_${crypto.randomUUID().replaceAll("-", "")}`,
                    toolName: codeTool.name,
                    input: JSON.stringify({
                      code: abandoned
                        ? "void tools.bash({command: 'sleep 3; touch /workspace/abandoned-proof', timeout: 10000}); void tools.write({file_path: '/workspace/abandoned-queued-proof', content: 'must never write'}); await new Promise(resolve => setTimeout(resolve, 100)); return 'unawaited';"
                        : "const kept = await tools.bash({command: 'test -f /tmp/cf-smoke-t2.txt && printf T2_KEPT', timeout: 10000}); return [...await Promise.all([tools.lookup({query:'first'}), tools.lookup({query:'second'})]), kept.content[0].text];",
                    }),
                  },
                ]),
            {
              type: "finish",
              finishReason: { unified: received ? "stop" : "tool-calls", raw: "scripted" },
              usage: {
                inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
                outputTokens: { total: 5, text: 5, reasoning: 0 },
              },
            },
          ],
        }),
      };
    }
    const codex = definitions.find((tool) => tool.name === "exec_command");
    const reply = (
      step: { name: string | undefined; input: object } | undefined,
      answer: string,
    ) => {
      if (step && !step.name) throw new Error(`Missing tool for ${answer}`);
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start" as const, warnings: [] },
            ...(step
              ? [
                  {
                    type: "tool-call" as const,
                    toolCallId: `call_${crypto.randomUUID().replaceAll("-", "")}`,
                    toolName: step.name ?? "missing",
                    input: JSON.stringify(step.input),
                  },
                ]
              : [
                  { type: "text-start" as const, id: "answer" },
                  { type: "text-delta" as const, id: "answer", delta: answer },
                  { type: "text-end" as const, id: "answer" },
                ]),
            {
              type: "finish" as const,
              finishReason: {
                unified: step ? ("tool-calls" as const) : ("stop" as const),
                raw: "scripted",
              },
              usage: {
                inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
                outputTokens: { total: 5, text: 5, reasoning: 0 },
              },
            },
          ],
        }),
      };
    };
    const shell = (command: string) =>
      codex
        ? {
            name: codex.name,
            input: { cmd: command, workdir: "/workspace", max_output_tokens: 100 },
          }
        : {
            name: definitions.find((tool) => tool.name === "bash" || tool.name.endsWith("__bash"))
              ?.name,
            input: { command, description: "Delegation proof" },
          };
    // Cross-runtime delegation: the parent starts a child on another preset, waits for it,
    // and the child proves it shares the parent's sandbox.
    if (request.includes("delegate-proof")) {
      const delegateTool = definitions.find((tool) => tool.name.endsWith("cf_delegate"));
      const waitTool = definitions.find((tool) => tool.name.endsWith("cf_wait"));
      // MCP schema round-trips turn a one-value enum into a const.
      const schema = delegateTool?.inputSchema as
        | { properties?: { model?: { enum?: string[]; const?: string } } }
        | undefined;
      const target = schema?.properties?.model?.enum?.[0] ?? schema?.properties?.model?.const;
      if (!delegateTool || !waitTool || !target) throw new Error("Delegation tools are missing");
      const results = JSON.stringify(toolResults);
      if (results.includes("CHILD_DONE")) return reply(undefined, "Delegation complete.");
      if (results.includes("subagent_")) return reply({ name: waitTool.name, input: {} }, "");
      return reply(
        {
          name: delegateTool.name,
          input: { model: target, prompt: "child-proof: create the child file.", name: "helper" },
        },
        "",
      );
    }
    // One shell step, then the answer.
    const once = (step: ReturnType<typeof shell>, answer: string) =>
      reply(toolResults.length ? undefined : step, answer);
    if (request.includes("child-proof"))
      return once(
        shell("printf CHILD_FILE > /workspace/child.txt && cat /workspace/child.txt"),
        "CHILD_DONE",
      );
    // A cross-runtime fork receives the source transcript as leading input.
    if (request.includes("verify-ported")) {
      if (!history.includes("Delegation complete")) throw new Error("Missing forked transcript");
      return once(shell("cat /workspace/proof.txt"), "Ported history restored.");
    }
    if (request.includes("verify-child-file")) {
      if (toolResults.length && !JSON.stringify(toolResults).includes("CHILD_FILE"))
        throw new Error("Child file is missing from the shared workspace");
      return once(shell("cat /workspace/child.txt"), "Child file present.");
    }
    // After a cancelled turn the sandbox is restored from the last checkpoint: /workspace
    // is back, state outside it (the T2 marker) is gone.
    if (request.includes("verify-home-reset"))
      return once(
        shell(
          "test ! -e /tmp/cf-smoke-t2.txt && test -f /workspace/proof.txt && printf HOME_RESET",
        ),
        "Home reset verified.",
      );
    // Codex discovers capabilities natively; Claude Code and OpenCode receive
    // discovered skill metadata through their instructions.
    if (!history.includes("INLINE_PLUGIN_CATALOG_PROOF"))
      throw new Error("Inline plugin skill was not discovered by the harness");
    if (!history.includes("SAVED_SKILL_PIN_PROOF") || history.includes("WRONG_NEW_SKILL_VERSION"))
      throw new Error("Pinned saved skill was not preserved through restore");
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
              // Turn 1 sees the setup marker outside /workspace (provisioned sandbox reused);
              // the restored turn 2 must not, and leaves its own marker for turn 3.
              cmd: restored
                ? "test ! -e /tmp/cf-smoke-home.txt && printf T2 > /tmp/cf-smoke-t2.txt && test -f /workspace/uploaded.txt && cat /workspace/proof.txt"
                : 'test -f /tmp/cf-smoke-home.txt && test -f /workspace/.agents/skills/smoke/SKILL.md && test -f /workspace/setup.txt && test "$EXAMPLE_SETTING" = configured && printf sandbox-only > /workspace/proof.txt && mkdir -p /workspace/outputs && cp /workspace/proof.txt /workspace/outputs/proof.txt && cat /workspace/proof.txt',
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
                command:
                  "test ! -e /tmp/cf-smoke-home.txt && printf T2 > /tmp/cf-smoke-t2.txt && cat /workspace/proof.txt",
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
                  'test -f /tmp/cf-smoke-home.txt && test -f /workspace/.agents/skills/smoke/SKILL.md && test -f /workspace/setup.txt && test "$EXAMPLE_SETTING" = configured && mkdir -p /workspace/outputs && cp /workspace/proof.txt /workspace/outputs/proof.txt && cat /workspace/proof.txt',
                description: "Verify the separate workspace",
              },
            },
          ];
    const mcp = definitions.find((tool) => tool.name.endsWith("__lookup"));
    const search = definitions.find((tool) => tool.name === "tool_search");
    const mcpProof = JSON.stringify(toolResults).includes("MCP_LOOKUP_PROOF");
    const step = codex
      ? !JSON.stringify(toolResults).includes("sandbox-only")
        ? steps[0]
        : !mcpProof
          ? mcp
            ? { name: mcp.name, input: {} }
            : { name: search?.name, input: { query: "lookup MCP fixture", limit: 1 } }
          : undefined
      : (steps[toolResults.length] ??
        (!restored && !mcpProof
          ? mcp
            ? { name: mcp.name, input: {} }
            : { name: undefined, input: {} }
          : undefined));
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
                  delta: restored ? "Native history restored." : "Container execution complete.",
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
  }
}
interface SearchFixtureRequest {
  model?: string;
  tools?: {
    type: string;
    external_web_access?: boolean;
    filters?: { allowed_domains?: string[] };
  }[];
  input?: unknown;
}
export class Models extends WorkerEntrypoint {
  override async fetch(request: Request): Promise<Response> {
    const body = await request.clone().json<SearchFixtureRequest>();
    if (body.model === "search-fixture") {
      const search = body.tools?.find((tool) => tool.type === "web_search");
      if (
        search?.external_web_access !== false ||
        search.filters?.allowed_domains?.[0] !== "example.org" ||
        !JSON.stringify(body.input).includes('"input_image"')
      )
        return Response.json(
          { error: { message: "Codex search/image egress contract failed" } },
          { status: 400 },
        );
      const output = [
        {
          type: "web_search_call",
          id: "search",
          status: "completed",
          action: { type: "search", query: "fixture", queries: ["fixture"] },
        },
        {
          type: "message",
          id: "answer",
          role: "assistant",
          content: [{ type: "output_text", text: "Cached search and image verified." }],
        },
      ];
      const event = (type: string, data: object) =>
        `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
      return new Response(
        [
          event("response.created", {
            response: {
              id: "search-response",
              object: "response",
              status: "in_progress",
              output: [],
            },
          }),
          ...output.flatMap((item, output_index) => [
            event("response.output_item.added", { item, output_index }),
            event("response.output_item.done", { item, output_index }),
          ]),
          event("response.completed", {
            response: {
              id: "search-response",
              object: "response",
              status: "completed",
              output,
              usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
            },
          }),
        ].join(""),
        { headers: { "content-type": "text/event-stream" } },
      );
    }
    return gateway.fetch(request, {});
  }
}
export class McpFixture extends WorkerEntrypoint {
  override async fetch(request: Request): Promise<Response> {
    if (
      new URL(request.url).href !== "https://mcp.fixture/mcp" ||
      request.headers.get("authorization") !== "Bearer fixture-mcp-token"
    )
      return new Response("MCP authentication failed", { status: 401 });
    if (request.method === "GET") return new Response(null, { status: 405 });
    const body = await request.json<{
      id?: string | number;
      method?: string;
      params?: { _meta?: { fixture?: boolean } };
    }>();
    if (!body.params?._meta?.fixture)
      return new Response("Missing MCP request metadata", { status: 400 });
    if (body.id === undefined) return new Response(null, { status: 202 });
    const result =
      body.method === "initialize"
        ? {
            protocolVersion: "2025-03-26",
            capabilities: { tools: {} },
            serverInfo: { name: "fixture", version: "1" },
          }
        : body.method === "tools/list"
          ? {
              tools: [
                {
                  name: "lookup",
                  description: "Read the MCP fixture value",
                  inputSchema: { type: "object", properties: {} },
                },
              ],
            }
          : body.method === "tools/call"
            ? { content: [{ type: "text", text: "MCP_LOOKUP_PROOF" }] }
            : {};
    return Response.json({ jsonrpc: "2.0", id: body.id, result });
  }
}
