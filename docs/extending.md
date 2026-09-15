# Extending the service

A deployment chooses the native harness and the model separately. Clients name presets; model instances and credentials stay inside the private gateway. A session pins the harness revision and the gateway model name at creation. Changing a preset changes new sessions; version preset names when old sessions must keep their original mapping.

## Presets, harnesses and the model gateway

This is the composition in [examples/worker/src/index.ts](../examples/worker/src/index.ts):

```ts
import { createOpenAI } from "@ai-sdk/openai";
import {
  bearerTenant,
  containerEnvironments,
  containerHarnesses,
  createAgentService,
} from "cf-open-agents-api/cloudflare";
import { aiSDKModel, createModelGateway, nativeModel } from "cf-open-agents-api/models";
import { createWorkersAI } from "workers-ai-provider";

const service = createAgentService<Bindings>({
  agents: {
    coding: {
      harness: "codex",
      model: "codex",
      delegates: ["claude", "opencode"],
      webSearch: true,
    },
    claude: { harness: "claude-code", model: "primary", delegates: ["coding", "opencode"] },
    opencode: { harness: "opencode", model: "primary", delegates: ["coding", "claude"] },
    workers: { harness: "codex", model: "workers" },
  },
  harnesses: containerHarnesses,
  objects: (env) => env.CHECKPOINTS,
  environments: containerEnvironments,
  authenticate: (request, env) => bearerTenant(request, env.API_TOKEN, "default"),
});
// Registry entries may be factories; a preset is built only when a session selects it.
const gateway = createModelGateway<Bindings>((env) => ({
  codex: () =>
    nativeModel({
      protocol: "responses",
      baseURL: "https://api.openai.com/v1",
      apiKey: env.OPENAI_API_KEY,
      model: "gpt-6-astra",
    }),
  primary: () => aiSDKModel(createOpenAI({ apiKey: env.OPENAI_API_KEY })("gpt-6-astra")),
  workers: () => aiSDKModel(createWorkersAI({ binding: env.AI })("@cf/zai-org/glm-4.7-flash")),
}));
// A private WorkerEntrypoint named Models delegates fetch(request) to gateway.fetch(request, this.env).
```

Each preset (`AgentRegistration`) has:

| Field       | Meaning                                                                                                                                                                                                                                                                                                                                                                    |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `harness`   | `codex`, `claude-code`, `opencode`, or the name of a custom driver in `harnesses`.                                                                                                                                                                                                                                                                                         |
| `model`     | The gateway registry name the harness sends as `model`. The gateway swaps it for the real upstream model.                                                                                                                                                                                                                                                                  |
| `delegates` | Presets a session on this alias may start subagents on when the client enables `multi_agent`. Every listed alias must exist and its harness must be registered, or creation fails with `503 delegate_unavailable`. Children run on the delegate's harness and model inside the parent's sandbox, so list only presets whose model spend you accept on the parent's behalf. |
| `webSearch` | Declares that this alias's model connection provides hosted web search. `web_search` tools are accepted only when both the harness (`codex` or `claude-code`) and the alias support it. A `nativeModel` Responses or Anthropic connection qualifies; the portable adapter does not.                                                                                        |

The gateway performs one inference per request. It has no tool implementations and starts no second agent loop; the runtime owns tool selection, continuation and native history. Switching `harness` changes new sessions and does not convert an existing checkpoint; use a [fork](environments-and-tools.md#fork-a-session) to move a session.

Both example model IDs are in the providers' catalogs, [GPT-6 Astra](https://developers.openai.com/api/docs/models/gpt-6-astra) and [GLM-4.7-Flash](https://developers.cloudflare.com/workers-ai/models/glm-4.7-flash/), checked September 13, 2026. Availability to your account and inference quality are separate from the scripted tests. The deployment supplies its AI SDK provider package; see Cloudflare's [AI SDK integration](https://developers.cloudflare.com/workers-ai/configuration/ai-sdk/).

## Model protocols

Each harness speaks one protocol to the gateway: Codex `/v1/responses`, Claude Code `/v1/messages`, OpenCode `/v1/chat/completions`. A gateway entry must be able to answer the protocol of every harness whose presets reference it.

### `nativeModel`

```ts
import { nativeModel } from "cf-open-agents-api/models";
const model = nativeModel({
  protocol: "anthropic", // "responses" or "chat-completions"
  baseURL: "https://api.anthropic.com/v1",
  apiKey: env.ANTHROPIC_API_KEY,
  model: env.CLAUDE_MODEL,
});
```

`nativeModel` forwards the harness request body unchanged except for the `model` field, and streams the provider response back. It is the only way to keep provider reasoning signatures, encrypted content, caching hints and hosted tools such as web search. It enforces the protocol: a Codex preset pointing at an `anthropic` entry fails with `model_protocol_mismatch`. Redirects are never followed, and provider error bodies are sanitized and bounded before they reach the harness.

Claude Code is designed for Claude models. Anthropic does not officially support routing it to other model families; the protocol tests here establish transport and tool behavior with scripted models, not provider approval. See [Claude Code LLM gateways](https://code.claude.com/docs/en/llm-gateway).

### `aiSDKModel` and `openAICompatibleModel`

`aiSDKModel(model, options)` accepts any instantiated AI SDK `LanguageModel`, including Workers AI, and answers all three protocols by translating the request and re-encoding the stream. `openAICompatibleModel(options)` wraps an OpenAI-compatible Chat Completions endpoint with the same translation.

```ts
import { aiSDKModel, openAICompatibleModel } from "cf-open-agents-api/models";

const portable = aiSDKModel(createOpenAI({ apiKey: env.OPENAI_API_KEY })("gpt-6-astra"), {
  maxOutputTokens: 8192, // upper bound; the harness may ask for less
  timeoutMs: 120_000,
  // Static options, or a function of the settings decoded from the harness request.
  providerOptions: ({ reasoningEffort, outputSchema }) =>
    reasoningEffort ? { openai: { reasoningSummary: "auto" } } : undefined,
});
const compatible = openAICompatibleModel({
  baseURL: "https://inference.example.com/v1",
  apiKey: env.INFERENCE_KEY,
  model: "your-model",
  headers: { "x-tenant": "agents" },
  supportsStructuredOutputs: true, // default; false sends json_object instead of json_schema
});
```

What the portable profile carries:

- Text, images and function calls in both directions, including Codex tool namespaces and custom text tools wrapped as an `input` string.
- Reasoning effort from every protocol (`reasoning.effort`, `reasoning_effort`, `output_config.effort` or a thinking budget) into the AI SDK's `reasoning` setting; `max` becomes `xhigh`.
- `json_schema` structured output from every protocol into a typed `output`.
- Reasoning text the provider streams, projected as a summary.

What it does not carry: provider reasoning blocks and signatures across requests, encrypted reasoning, server-side response references, hosted tools (web search), and provider-specific sampling or caching options. Set those through `providerOptions` if the upstream accepts them. Output truncation or a provider error fails the turn. Provider error bodies are sanitized before they reach the harness.

`modelAdapter(effect)` adapts an Effect-valued implementation to the gateway contract when neither helper fits.

## Sandbox replacement

| Harness                  | Integration                                                                                       | Native state                            |
| ------------------------ | ------------------------------------------------------------------------------------------------- | --------------------------------------- |
| Codex 0.154.0            | Native remote `exec-server` in the sandbox container                                              | Isolated `CODEX_HOME`                   |
| Claude Agent SDK 0.3.268 | `toolAliases` redirect Bash, Read, Write and Edit to SDK MCP tools that call the assigned sandbox | Isolated `CLAUDE_CONFIG_DIR`            |
| OpenCode 1.18.30         | Same-name plugin tools replace `bash`, `read`, `write` and `edit` and call the assigned sandbox   | Isolated XDG data and state directories |

Claude's `sandbox` option configures local OS isolation, not a remote sandbox. The adapter uses `toolAliases` plus an SDK-connected MCP server and disallows every native local tool; `canUseTool` allows only the workspace server, hosted `WebSearch` when the agent has a `web_search` tool, and `Task` when subagents are enabled. Its MCP server comes from the installed MCP SDK so current Zod fields parse with a compatible version.

OpenCode supports [overriding built-in tool names](https://opencode.ai/docs/custom-tools/#name-collisions-with-built-in-tools). The bundled plugin replaces four native tools. Other builtins, project config, default plugins, model discovery and automatic updates are disabled. The config directory is read-only while OpenCode runs so its background plugin installer never needs the network. Provider SDKs are bundled in the pinned CLI; caches are excluded from checkpoints.

All three adapters route client function tools to the session's required-action boundary, accept steering during a turn, run native subagents and delegated children, connect configured MCP servers, discover deferred functions through `cf_tool_search`, read environment skills and plugins, run `cf_execute` code, project reasoning summaries, command output and usage, accept images, and checkpoint and restore native history. Claude Code and OpenCode reach MCP servers through the supervisor's tool bridge; their tool names are prefixed (`mcp__workspace__` for Claude Code, `workspace_` for OpenCode).

## Additional harnesses

Implement `RuntimeDriver` and register its name in `harnesses`. `start`, `poll`, `control`, `checkpoint` and `stop` return `Effect<A, ServiceError>`; `fromPromiseDriver` adapts a Promise implementation. Runtime schemas are Effect schemas: decode with `decodeEffect(schema, value)` inside a program or `decode(schema, value)` at a synchronous boundary.

A driver must deduplicate operation IDs, fence old attempts by generation, preserve native history, and contain old executors before replacing them. A missing acknowledged job is a failure, never permission to start again. `control` must fail with `409 command_rejected` when a command can never apply (the Worker then drops it, or re-queues a steer as the next turn) and with a plain I/O error when the outcome is unknown (the Worker retries). Fail a job with one of the SDK's `SessionTurnError` codes; other strings surface as `internal_error`.

Declare only the [capability flags](compatibility.md#capability-flags) the driver implements; session creation rejects configurations the flags do not cover. An execution carries `delegates` and `maxConcurrentSubagents` when the session may delegate, and `parent` when the driver runs a delegated child. A driver that ignores those fields never spawns children. A custom `EnvironmentDriver` must honor `EnvironmentSpec.inherited` in `prepare` or reject it, so a fork never silently loses the source workspace.

A model provider that speaks one of the three protocols needs no driver, only a gateway entry. A different agent runtime needs a driver and, for the container drivers, a supervisor adapter.

## Tools and assets

`defineTool` validates arguments and results with Effect Schema and takes an Effect-valued `execute`. Use its `effect` method for composition and its `call` Promise adapter in SDK tool handlers. `webSearch` and `knowledgeSearch` wrap provider functions and return source URLs; a corpus search is not presented as a public-web search.

```ts
import { webSearch } from "cf-open-agents-api/tools";

const search = webSearch(async (query, signal) => yourSearchProvider(query, { signal }));
const session = await client.beta.agents.sessions.create({
  agent: { model: "coding", tools: [search.spec] },
  environment: { type: "none" },
});
const stream = client.beta.agents.sessions.stream(session.id, {
  input: "Find the Cloudflare Durable Objects documentation.",
  toolHandlers: {
    web_search: async (args) => ({
      results: await search.call(args, {
        tenantId: "your-authenticated-tenant",
        sessionId: session.id,
        operationId: crypto.randomUUID(),
        signal: stream.controller.signal,
      }),
    }),
  },
});
for await (const event of stream) console.log(event.type);
```

Client functions wait for API input. Installing a helper does not grant the server permission to execute it; your application applies authentication, budgets, retries and side-effect policy. MCP is an adapter to that boundary, not another source of authority.

`publishSkill(bucket, bundle)` stores immutable SHA-256-addressed bundles, requires `SKILL.md`, rejects traversal and absolute paths, and caps bundle size. `loadSkill` verifies integrity. `skillReader(bucket, allowedReferences)` exposes a portable `read_skill` function restricted to a deployment-owned allowlist. These helpers predate the Skills API and remain for deployments that manage skills in code.

Provision files before native execution with the harness factory:

```ts
import { createHarness } from "cf-open-agents-api/cloudflare";
import { installSkill } from "cf-open-agents-api/tools";

const Harness = createHarness<Bindings>(async (sandbox, execution, env) => {
  const reference = await yourSkillCatalog(env, execution.agent.model);
  await installSkill(env.CHECKPOINTS, reference, sandbox);
});
export { Harness as HarnessDO };
```

The hook runs once per fresh workspace, before `exec-server` and the first model call. A reused or restored sandbox skips it. Export the returned class directly: outbound handlers are registered by concrete class name through the Container SDK's static setter, and an unregistered subclass does not inherit them.

Knowledge indexing stays application-owned. `knowledgeSearch` accepts AI Search, Vectorize or any retrieval provider that returns the common result shape.
