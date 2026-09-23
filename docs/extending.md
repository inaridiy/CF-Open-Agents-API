# Extending the service

A deployment chooses the native harness and the model separately. Clients name presets; model instances and credentials stay inside the private gateway. A session pins the harness revision and the gateway model name at creation. Changing a preset changes new sessions; version preset names when old sessions must keep their original mapping.

## Presets, harnesses and the model gateway

This is the composition in [examples/worker/src/index.ts](../examples/worker/src/index.ts), which the setup CLI also generates:

```ts
import { createOpenAI } from "@ai-sdk/openai";
import {
  type AgentBindings,
  bearerTenant,
  type ContainerBindings,
  defineAgentWorker,
} from "cf-open-agents-api/cloudflare";
import { aiSDKModel, nativeModel } from "cf-open-agents-api/models";
import { createWorkersAI } from "workers-ai-provider";

// Wrangler bindings the composition reads: the library's Durable Objects, buckets and
// gateway (AgentBindings, ContainerBindings), plus the secrets and bindings named here.
// Secrets come from .dev.vars locally and from `wrangler secret put` in production.
interface Bindings extends AgentBindings, ContainerBindings {
  AI: Ai;
  API_TOKEN: string;
  OPENAI_API_KEY: string;
}

// Wrangler binds the Durable Objects by these export names and the private model
// gateway by the `Models` entrypoint; keep them as they are.
export const { Agents, Models, SessionDO, TenantCatalogDO, HarnessDO, SandboxDO, ContainerProxy } =
  defineAgentWorker<Bindings>({
    // Presets: the `agent.model` names clients send. Each maps to a native runtime
    // (`harness`) and a gateway registry name (`model`). Optional fields: `delegates` lists
    // the presets a session may start subagents on when multi_agent is enabled (children
    // share the parent's sandbox); `tiers` names the registry entries Claude Code's
    // haiku/sonnet/opus subagent tiers resolve to; `webSearch` declares that the model
    // connection provides hosted web search (a nativeModel connection, not the AI SDK path).
    agents: {
      codex: {
        harness: "codex",
        model: "codex",
        delegates: ["claude", "opencode"],
        webSearch: true,
      },
      claude: {
        harness: "claude-code",
        model: "primary",
        tiers: { haiku: "fast" },
        delegates: ["codex", "opencode"],
      },
      opencode: { harness: "opencode", model: "primary", delegates: ["codex", "claude"] },
      workers: { harness: "codex", model: "workers" },
    },
    // The private model gateway. Keys are deployment-owned names that presets point at;
    // runtimes never see provider URLs or keys. Each entry is a factory built only when a
    // session selects it, so a deployment without one provider's credentials still serves
    // the other presets. Add a model here, then point a preset's `model` at it.
    models: (env) => ({
      codex: () =>
        nativeModel({
          protocol: "responses",
          baseURL: "https://api.openai.com/v1",
          apiKey: env.OPENAI_API_KEY,
          model: "gpt-6-astra",
        }),
      primary: () => aiSDKModel(createOpenAI({ apiKey: env.OPENAI_API_KEY })("gpt-6-astra")),
      fast: () => aiSDKModel(createOpenAI({ apiKey: env.OPENAI_API_KEY })("gpt-5.6-luna")),
      workers: () => aiSDKModel(createWorkersAI({ binding: env.AI })("@cf/zai-org/glm-5.3-flash")),
      workersQwen: () => aiSDKModel(createWorkersAI({ binding: env.AI })("@cf/qwen/qwen3.8-27b")),
    }),
    // Who may call the API. `bearerTenant` accepts one shared bearer token (API_TOKEN, at
    // least 32 characters) and maps every caller to the tenant "default"; Service Binding
    // callers pass the same token. Replace it to resolve tenants from your own auth.
    authenticate: (request, env) => bearerTenant(request, env.API_TOKEN, "default"),
  });
export default Agents;
```

The `Models` entrypoint is the private model gateway; `MODEL_GATEWAY` binds it from the same Worker. See the [library API](library-api.md#composition) for every option and for `createAgentService`, the lower-level factory.

Each preset (`AgentRegistration`) has:

| Field       | Meaning                                                                                                                                                                                                                                                                                                                                                                                |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `harness`   | `codex`, `claude-code`, `opencode`, or the name of a custom driver in `harnesses`.                                                                                                                                                                                                                                                                                                     |
| `model`     | The gateway registry name the harness sends as `model`. The gateway swaps it for the real upstream model.                                                                                                                                                                                                                                                                              |
| `delegates` | Presets a session on this alias may start subagents on when the client enables `multi_agent`. Every listed alias must exist and its harness must be registered, or creation fails with `503 delegate_unavailable`. Children run on the delegate's harness and model inside the parent's sandbox, so list only presets whose model spend you accept on the parent's behalf.             |
| `tiers`     | Gateway registry names a Claude Code session may switch to per model tier: `{ haiku?, sonnet?, opus? }`. The parent's Agent tool accepts `model: "haiku"`, `"sonnet"` or `"opus"` for a native subagent; each alias resolves to the name listed here, and a missing tier falls back to `model`. Pinned with the session at creation and fork, like `model`. Other harnesses ignore it. |
| `webSearch` | Declares that this alias's model connection provides hosted web search. `web_search` tools are accepted only when both the harness (`codex` or `claude-code`) and the alias support it. A `nativeModel` Responses or Anthropic connection qualifies; the portable adapter does not.                                                                                                    |

A registry entry is a `ModelRegistration`: an adapter, or a factory such as `() => nativeModel(...)` that is called only when a session selects that name. A deployment that lacks one provider's credentials still serves its other presets; the example's `.dev.vars.example` leaves `OPENAI_API_KEY` empty so the `workers` preset runs alone. The gateway performs one inference per request. It has no tool implementations and starts no second agent loop; the runtime owns tool selection, continuation and native history. Switching `harness` changes new sessions and does not convert an existing checkpoint; use a [fork](environments-and-tools.md#fork-a-session) to move a session.

The registry holds several models per provider so that presets and tiers can point at different ones: `codex` is the native Responses connection to GPT-6 Astra, `primary` and `fast` are GPT-6 Astra and GPT-5.6 Luna through the AI SDK, `workers` is `@cf/zai-org/glm-5.3-flash` and `workersQwen` is `@cf/qwen/qwen3.8-27b` on Workers AI. The `claude` preset resolves its `haiku` tier to `fast`; the CLI's Anthropic variant renders `opus`, `sonnet` and `haiku` native entries instead and gives the `claude` preset `tiers: { haiku: "haiku", sonnet: "sonnet" }`. Client `agent.model` values stay `codex`, `claude`, `opencode` or `workers` in every variant.

The example model IDs are in the providers' catalogs, [GPT-6 Astra and GPT-5.6 Luna](https://developers.openai.com/api/docs/models), [GLM-5.3-Flash](https://developers.cloudflare.com/workers-ai/models/glm-5.3-flash/) and [Qwen 3.8 27B](https://developers.cloudflare.com/workers-ai/models/qwen3.8-27b/), checked on 2026-09-19. Availability to your account and inference quality are separate from the scripted tests. The deployment supplies its AI SDK provider package; see Cloudflare's [AI SDK integration](https://developers.cloudflare.com/workers-ai/configuration/ai-sdk/).

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
  maxOutputTokens: 32_768, // optional upper bound; unset, the provider's own limit applies
  timeoutMs: 600_000, // optional; unset, only the turn deadline bounds a request
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

### `fallbackModel`

`fallbackModel(candidates)` makes one registry entry out of several models, tried in the order written. A candidate is skipped when it fails before producing any output: `aiSDKModel` fails the request with `ModelUpstreamRejected` when the provider answers with an error before its first token (Workers AI at capacity, a quota, a bad key), and `nativeModel` passes the provider's status through, so a 429 or 5xx moves on as well. Output that already started streaming is never retried elsewhere, because the harness has seen it. Each candidate is built only when its turn comes, every switch is logged as `Model fallback`, and the last outcome answers when all of them failed.

```ts
import { fallbackModel } from "cf-open-agents-api/models";

models: (env) => {
  const workersAI = createWorkersAI({ binding: env.AI });
  return {
    workers: () =>
      fallbackModel({
        deepseek: () => aiSDKModel(workersAI("@cf/deepseek-ai/deepseek-v4-flash-0731")),
        glm: () => aiSDKModel(workersAI("@cf/zai-org/glm-5.3-flash")),
        qwen: () => aiSDKModel(workersAI("@cf/qwen/qwen3.8-27b")),
      }),
  };
},
```

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

Implement `RuntimeDriver` and register its name in `harnesses`. `start`, `poll`, `control`, `checkpoint` and `stop` return Effects whose failures are the tagged classes the root import exports: `RuntimeRejected` and `TransportFailure` from `start` and `checkpoint`, `CommandRejected`, `ExecutionMissing` and `TransportFailure` from `control`, `TransportFailure` alone from `poll` and `stop`. `fromPromiseDriver` adapts a `PromiseRuntimeDriver`, whose methods also receive the fiber's `AbortSignal` and a `poll` options object; a thrown `{ status, code }` answer becomes the matching tag and anything else a `TransportFailure`. Runtime schemas are Effect schemas: decode with `decodeEffect(schema, value)` inside a program or `decode(schema, value)` at a synchronous boundary. The [library API](library-api.md#effect-extension-contracts) lists the signatures.

A driver must deduplicate operation IDs, fence old attempts by generation, preserve native history, and contain old executors before replacing them. A missing acknowledged job is a failure, never permission to start again. `control` must fail with `CommandRejected` when a command can never apply (the Worker then drops it, or re-queues a steer as the next turn), with `ExecutionMissing` when it owns no such job, and with `TransportFailure` when the outcome is unknown (the Worker polls, then retries). Fail a job with one of the SDK's `SessionTurnError` codes; other strings surface as `internal_error`.

`poll(execution, after, { waitMs })` may return at once. A driver that can hold an empty answer until an event or a terminal outcome arrives, for up to `waitMs`, declares `longPoll: true`; the reconciler then polls it for the rest of each alarm interval and keeps polling while events arrive, so clients see events at the runtime's pace. The container drivers do this through the supervisor's `GET /jobs/:turn?after=&wait=` (at most 25 seconds per wait). A driver without the flag is polled once per alarm interval (`pollIntervalMs`, 5 seconds by default) with `waitMs` zero.

Declare only the [capability flags](compatibility.md#capability-flags) the driver implements; session creation rejects configurations the flags do not cover. An execution carries `delegates` and `maxConcurrentSubagents` when the session may delegate, and `parent` when the driver runs a delegated child. A driver that ignores those fields never spawns children. A custom `EnvironmentDriver` must honor `EnvironmentSpec.inherited` in `prepare` or reject it, so a fork never silently loses the source workspace.

A model provider that speaks one of the three protocols needs no driver, only a gateway entry. A different agent runtime needs a driver and, for the container drivers, a supervisor adapter.

## Tools and assets

`defineTool` validates arguments and results with Effect Schema and takes an Effect-valued `execute`. Use its `effect` method for composition and its `call` Promise adapter in SDK tool handlers. `webSearch` and `knowledgeSearch` wrap provider functions and return source URLs; a corpus search is not presented as a public-web search. [Web search](web-search.md) compares this with the provider's hosted search.

```ts
import { webSearch } from "cf-open-agents-api/tools";

const search = webSearch(async (query, signal) => yourSearchProvider(query, { signal }));
const session = await client.beta.agents.sessions.create({
  agent: { model: "codex", tools: [search.spec] },
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
export const { HarnessDO, ...rest } = defineAgentWorker<Bindings>({ ...options, harness: Harness });
```

The hook runs once per fresh workspace, before `exec-server` and the first model call. A reused or restored sandbox skips it. Export the returned class directly (`defineAgentWorker` returns it unchanged as `HarnessDO`): outbound handlers are registered by concrete class name through the Container SDK's static setter, and an unregistered subclass does not inherit them.

Knowledge indexing stays application-owned. `knowledgeSearch` accepts AI Search, Vectorize or any retrieval provider that returns the common result shape.
