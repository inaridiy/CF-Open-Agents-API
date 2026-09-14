# Extending the service

A deployment selects a native harness and model separately. Session requests name
agent presets; model instances and credentials stay inside the private Worker gateway.
The session pins the harness revision and model-registry name. Changing a registry
entry changes that name's upstream connection; version registry names when old
sessions must keep their original model configuration.

## Native harnesses and AI SDK models

```ts
import { createOpenAI } from "@ai-sdk/openai";
import { containerHarnesses, createAgentService } from "cf-open-agents-api/cloudflare";
import { aiSDKModel, createModelGateway } from "cf-open-agents-api/models";

const service = createAgentService<Bindings>({
  agents: {
    coding: { harness: "codex", model: "primary", delegates: ["claude"] },
    claude: { harness: "claude-code", model: "primary", delegates: ["coding", "opencode"] },
    opencode: { harness: "opencode", model: "primary" },
  },
  harnesses: containerHarnesses,
  authenticate: yourAuthenticator,
});
const gateway = createModelGateway<Bindings>((env) => {
  const openai = createOpenAI({ apiKey: env.OPENAI_API_KEY });
  return { primary: aiSDKModel(openai("gpt-6-astra")) };
});
// A private WorkerEntrypoint delegates fetch(request) to gateway.fetch(request, this.env).
```

The AI SDK call performs one inference. It has no tool implementations and starts
no second agent loop. Codex app-server, Claude Agent SDK, or OpenCode owns tool
selection, continuation, and native conversation history. Switching `harness` changes
new sessions; it does not convert an existing native checkpoint. Use the
[fork extension](environments-and-tools.md#fork-a-session) to continue an existing
session on another preset.

`delegates` names the presets a session on that alias may start subagents on
when the client enables `multi_agent`. Children run on the delegate's harness and
model inside the parent's sandbox, so list only presets whose model connection
you are willing to spend on that parent's behalf. Every listed alias must exist
and its harness must be registered; session creation checks this and reports
`delegate_unavailable` otherwise. Presets without `delegates` keep native Codex
subagents only.

Workers AI uses the same model adapter:

```ts
import { createWorkersAI } from "workers-ai-provider";
const model = aiSDKModel(createWorkersAI({ binding: env.AI })("@cf/zai-org/glm-4.7-flash"));
```

Both example IDs are listed in the providers' official catalogs:
[GPT-6 Astra](https://developers.openai.com/api/docs/models/gpt-6-astra) and
[GLM-4.7-Flash](https://developers.cloudflare.com/workers-ai/models/glm-4.7-flash/)
(checked September 13, 2026). Availability to a particular account and inference
quality are separate from the scripted integration tests.

The deployment supplies its AI SDK provider package. See the runnable
[Worker composition](../examples/worker/src/index.ts) and Cloudflare's
[AI SDK integration](https://developers.cloudflare.com/workers-ai/configuration/ai-sdk/).

## Model protocols

`aiSDKModel(instance, options)` exposes Responses, Anthropic Messages, and Chat
Completions to native harnesses. `openAICompatibleModel({ baseURL, apiKey, model })`
uses the same translation with an OpenAI-compatible Chat Completions upstream.
Options bound output tokens and request time and forward deployment-owned AI SDK
`providerOptions`. Model credentials are never sent to the harness or Sandbox.

This portable profile carries text and function calls, including Codex namespaces
and custom text tools wrapped as an `input` string. It **does not replay provider
reasoning blocks or signatures**; reasoning can occur within an inference, but only
text and function calls return to the harness. Media, encrypted input reasoning,
server-side response references, hosted tools and structured response formats are
rejected. Provider-specific sampling/effort/cache options are not a portable contract;
set supported upstream options in the deployment. Tool use quality and context limits
still depend on the selected model. Output truncation or model failure fails the turn.

Use `nativeModel` when native reasoning, signatures, caching or other extensions
must survive unchanged:

```ts
import { nativeModel } from "cf-open-agents-api/models";
const model = nativeModel({
  protocol: "anthropic", // "responses" or "chat-completions" also available
  baseURL: "https://api.anthropic.com/v1",
  apiKey: env.ANTHROPIC_API_KEY,
  model: env.CLAUDE_MODEL,
});
```

Native presets enforce the harness's protocol and replace the registry alias with
the actual upstream model. They preserve the payload and stream instead of applying
AI SDK translation. Base URLs and credentials belong to deployment code.

Claude Code is designed for Claude models. Anthropic does not officially support
routing it to other model families; our protocol tests establish transport/tool
behavior with scripted models, not quality or provider approval for every model.
See [Claude Code LLM gateways](https://code.claude.com/docs/en/llm-gateway).

## Sandbox replacement

| Harness                  | Actual integration                                                                          | Native state                        |
| ------------------------ | ------------------------------------------------------------------------------------------- | ----------------------------------- |
| Codex 0.154.0            | Native remote `exec-server` in Sandbox Container                                            | Isolated CODEX_HOME                 |
| Claude Agent SDK 0.3.268 | `toolAliases` redirect Bash/Read/Write/Edit to SDK MCP tools that call the assigned Sandbox | Isolated CLAUDE_CONFIG_DIR          |
| OpenCode 1.18.30         | Same-name plugin tools replace bash/read/write/edit and call the assigned Sandbox           | Isolated XDG data/state directories |

Claude's `sandbox` option configures local OS isolation; it is not a generic remote
Sandbox provider. `spawnClaudeCodeProcess` replaces the whole subprocess launcher.
The included adapter uses `toolAliases` plus an SDK-connected MCP server and disables
native local tools. Its server comes from the installed MCP SDK so current Zod
optional/default fields are parsed by a compatible version. This was verified against the installed SDK and its actual CLI.

OpenCode explicitly supports [overriding built-in tool names](https://opencode.ai/docs/custom-tools/#name-collisions-with-built-in-tools).
Our bundled plugin replaces four native tools. Other builtins, project config,
default plugins, subagents, model discovery and automatic updates are disabled.
The fixed config directory is read-only while OpenCode runs so its background
plugin dependency installer does not require network access. Provider SDKs are
already bundled in the pinned native CLI; caches are excluded from checkpoints.

Both adapters route external function tools to the session's required-action
boundary. The client submits their results through the Agents API. Builtin web
search is disabled; expose deployment-owned search as an ordinary function tool.
Codex enables provider web search when configured in `agent.tools`. All three
harnesses project reasoning summaries, usage and command deltas, accept image
input and image function results, connect configured MCP servers, discover
deferred functions through `cf_tool_search`, read environment skills and plugins,
and run `cf_execute` code and delegated subagents. Native search requires a
supporting Responses passthrough connection. Codex supports active steering; Claude
Code and OpenCode reject it. All support cancellation, external tools, and native
checkpoint/restore.

Claude Code and OpenCode reach configured MCP servers through the supervisor's
tool bridge: service-origin HTTP servers are proxied by the Worker with Vault
credentials, and environment-origin servers run inside the Sandbox behind a
private bridge process. Their tool names are prefixed by the bridge
(`mcp__workspace__` for Claude Code, `workspace_` for OpenCode).

## Additional harnesses

Implement `RuntimeDriver` and register its name in `harnesses`. Start, poll, control,
checkpoint, and stop return `Effect<A, ServiceError>` and compose without starting
a Promise. `fromPromiseDriver` adapts existing Promise implementations. Runtime
schemas are Effect schemas; decode with `decodeEffect(schema, value)` inside a
program or `decode(schema, value)` at a synchronous boundary.
Drivers must deduplicate operation IDs, fence
old attempts, preserve native history, and contain old executors before replacing
them. A missing acknowledged job is a failure, not permission to start again.
A DeepSeek model can use the model gateway; a DeepSeek harness needs its own driver.

Declare only the [capability flags](compatibility.md#capability-flags) the driver
implements; session creation rejects configurations the flags do not cover. An
execution carries `delegates` and `maxConcurrentSubagents` when the session may
delegate, and `parent` when the driver is asked to run a delegated child. A driver
that ignores those fields simply never spawns children. A custom
`EnvironmentDriver` must honor `EnvironmentSpec.inherited` in `prepare` or reject
it, so a fork never silently loses the source workspace.

See [Effect architecture](effect.md) for ownership, errors and migration details.

## Tools and assets

`defineTool` validates arguments and results with Effect Schema and accepts an
Effect-valued `execute`. Use its `effect` method for composition and its `call`
Promise adapter in SDK tool handlers. It records the tool's
effects and retry policy for application orchestration. `webSearch` and
`knowledgeSearch` accept provider functions and return source URLs; a corpus search
is not presented as a public-web search provider.

```ts
import { webSearch } from "cf-open-agents-api/tools";

const search = webSearch(async (query, signal) => {
  return yourSearchProvider(query, { signal });
});
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

Client functions deliberately wait for API input. Installing a helper does not
silently grant the server permission to execute it. Applications can bind their
own tool Worker and apply authentication, budgets, retries, and side-effect policy
there. MCP is an adapter to this boundary, not an additional source of authority.

`publishSkill(bucket, bundle)` stores immutable SHA-256-addressed UTF-8 bundles.
It requires `SKILL.md`, rejects traversal/absolute paths, and caps bundle size.
`loadSkill` verifies integrity. `skillReader(bucket, allowedReferences)` exposes a
portable `read_skill` function restricted to a deployment-owned allowlist.

Provision files before native execution with the shared harness factory:

```ts
import { createHarness } from "cf-open-agents-api/cloudflare";
import { installSkill } from "cf-open-agents-api/tools";

const Harness = createHarness<Bindings>(async (sandbox, execution, env) => {
  // Resolve a deployment-owned immutable reference, never an arbitrary client URL.
  const reference = await yourSkillCatalog(env, execution.agent.model);
  await installSkill(env.CHECKPOINTS, reference, sandbox);
});
export { Harness as HarnessDO };
```

The hook runs on a fresh workspace, before exec-server and model execution. It can
also initialize a repository. Restored workspaces retain their committed assets and
skip provisioning. `installSkill` writes `/workspace/.agents/skills/<name>`; scripts
execute only when the sandbox runs them. Use `read_skill` when explicit progressive
loading is preferable to harness-specific discovery.

Export the returned harness class directly as shown. Outbound handlers are registered
by concrete class name using the Container SDK's static setter. An unregistered
subclass does not inherit the SDK's handler registration.

Knowledge indexing remains application-owned. `knowledgeSearch` accepts an AI Search,
Vectorize, or other retrieval provider that returns the common result shape. Preserve
immutable source assets separately from derived indexes and conversational memory.
