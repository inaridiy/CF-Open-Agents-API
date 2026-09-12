# Extending the service

A deployment owns its model registry and runtime drivers. Requests name registry
aliases; they never serialize JavaScript provider objects or configuration secrets.
A session pins the selected driver name/revision and underlying model at creation.

## AI SDK and Workers AI

The optional `cf-open-agents-api/ai-sdk` entrypoint accepts any supported AI SDK
`LanguageModel` through an environment-aware factory:

```ts
import { aiSDKDriver, createAIHarness } from "cf-open-agents-api/ai-sdk";

const BaseAIHarness = createAIHarness<Bindings>((env, model) => {
  return yourProviderFactory(env)(model);
});
export class AIHarnessDO extends BaseAIHarness {}
```

Bind `AI_HARNESS` to that class and add it to a SQLite DO migration. Register
`"assistant": { driver: "ai-sdk", model: "your-provider-model" }` and include
`"ai-sdk": aiSDKDriver(env)` in the `drivers` factory. `CHECKPOINTS` is its R2 binding.

The example uses `workers-ai-provider@4.0.0` with AI SDK 7:

```ts
import { createWorkersAI } from "workers-ai-provider";
const BaseAIHarness = createAIHarness<Bindings>(
  (env, model) => createWorkersAI({ binding: env.AI })(model),
  { maxSteps: 32, maxOutputTokens: 8192 },
);
```

The instance lives only inside AIHarnessDO; its registry name and message checkpoint
are durable. The example's `assistant` alias selects
[GLM-4.7-Flash](https://developers.cloudflare.com/workers-ai/models/glm-4.7-flash/).
See the [official SDK integration](https://developers.cloudflare.com/workers-ai/configuration/ai-sdk/).
Other AI SDK providers use the same factory; providers remain optional dependencies.

AI SDK calls are single durable model steps. Function calls suspend the session;
submitted results become model messages before the next step. A process lost during
a model call is treated as an unknown outcome rather than silently making another
billable request. The AI SDK driver has no shell sandbox or steering capability.

## Additional harnesses

Implement `RuntimeDriver` and register its name. The interface separates start,
poll, control, checkpoint, and stop. Drivers must deduplicate operation IDs, fence
old attempts, preserve native history, and contain old executors before replacing
them. A missing acknowledged job is a failure, not permission to start again.

A Claude Code/OpenCode driver must either support remote native tool execution or
run its tool-executing process inside the sandbox boundary. Merely adding an MCP
shell tool does not redirect its built-in shell. DeepSeek is a model-provider choice
unless a concrete DeepSeek harness implementation is installed. Unsupported harness
names fail capability validation before a session is created.

For Codex, the native model gateway expects Responses API semantics. An arbitrary
Chat Completions model or AI SDK instance is not automatically compatible. Use the
AI SDK driver for those models; do not translate only the easiest request fields
and advertise full Codex compatibility.

## Tools and assets

`defineTool` validates both arguments and results with Zod. It records the tool's
effects and retry policy for application orchestration. `webSearch` and
`knowledgeSearch` accept provider functions and return source URLs; a corpus search
is not presented as a public-web search provider.

```ts
import { webSearch } from "cf-open-agents-api/tools";

const search = webSearch(async (query, signal) => {
  return yourSearchProvider(query, { signal });
});
const session = await client.beta.agents.sessions.create({
  agent: { model: "assistant", tools: [search.spec] },
  environment: { type: "none" },
});
const stream = client.beta.agents.sessions.stream(session.id, {
  input: "Find the Cloudflare Durable Objects documentation.",
  toolHandlers: {
    web_search: async (args) => ({ results: await search.call(args, {
      tenantId: "your-authenticated-tenant", sessionId: session.id,
      operationId: crypto.randomUUID(), signal: stream.controller.signal,
    }) }),
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

Provision files before native execution with the Codex factory:

```ts
import { createCodexHarness } from "cf-open-agents-api/cloudflare";
import { installSkill } from "cf-open-agents-api/tools";

const Harness = createCodexHarness<Bindings>(async (sandbox, execution, env) => {
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

Export the returned Codex class directly as shown. Outbound handlers are registered
by concrete class name using the Container SDK's static setter. An unregistered
subclass does not inherit the SDK's handler registration.

Knowledge indexing remains application-owned. `knowledgeSearch` accepts an AI Search,
Vectorize, or other retrieval provider that returns the common result shape. Preserve
immutable source assets separately from derived indexes and conversational memory.
