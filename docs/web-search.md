# Web search

An agent can reach the web in three ways here. The provider's own hosted search runs inside the model call; a function tool runs in your application; an MCP server runs wherever you host it. They differ in who executes the search, which runtimes and model connections can use them, and where the traffic leaves.

|                        | Hosted search                                                     | Function tool                                 | MCP server                                                                                      |
| ---------------------- | ----------------------------------------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Who runs the search    | The model provider, inside the inference                          | Your Worker or client, on a `required_action` | Your MCP server, called by the Worker (service origin) or from the sandbox (environment origin) |
| Runtimes               | Codex, Claude Code                                                | Codex, Claude Code, OpenCode                  | Codex, Claude Code, OpenCode                                                                    |
| Model connection       | A `nativeModel` entry only                                        | Any, including Workers AI                     | Any                                                                                             |
| What the model sees    | The provider's results and citations, as a `web_search_call` item | The JSON you return                           | The tool's output                                                                               |
| Where credentials live | The private gateway (the provider key)                            | Your application                              | A Vault (service origin)                                                                        |

Pick hosted search when a preset already runs Codex or Claude Code against the provider's own API and you want the provider's retrieval and citations. Pick a function tool when the preset runs OpenCode, Workers AI or any model behind the AI SDK adapter, when you want to choose the search backend, or when the results must be filtered, logged or billed by your application. Pick MCP when the search already exists as an MCP tool.

## Hosted search

Hosted search is a capability of the model connection, so a deployment enables it per preset, and a client asks for it per session.

### Enable it on a preset

The preset's `model` must be a `nativeModel` entry, and the preset must declare `webSearch: true`:

```ts
agents: {
  codex: { harness: "codex", model: "codex", webSearch: true },
  claude: { harness: "claude-code", model: "opus", webSearch: true },
},
models: (env) => ({
  codex: () =>
    nativeModel({
      protocol: "responses",
      baseURL: "https://api.openai.com/v1",
      apiKey: env.OPENAI_API_KEY,
      model: "gpt-6-astra",
    }),
  opus: () =>
    nativeModel({
      protocol: "anthropic",
      baseURL: "https://api.anthropic.com/v1",
      apiKey: env.ANTHROPIC_API_KEY,
      model: "claude-opus-5",
    }),
}),
```

Codex gets the Responses search tool; Claude Code gets Anthropic's hosted `WebSearch`. The portable adapters `aiSDKModel` and `openAICompatibleModel` translate between protocols and cannot carry a hosted tool, so a preset on them must not declare `webSearch`. OpenCode has no hosted search. `GET /cf/v1/capabilities` reports both halves: `agents.<preset>.webSearch` is the preset's declaration and `harnesses.<name>.webSearch` is the runtime's.

### Ask for it in a session

```ts
const session = await client.beta.agents.sessions.create({
  agent: {
    model: "codex",
    tools: [{ type: "web_search", mode: "live", allowed_domains: ["developer.mozilla.org"] }],
  },
  environment: { type: "openai_hosted" },
  input: "Check the current MDN guidance on the View Transitions API and summarize it.",
});
```

`mode` is `live` (the default when the tool is present), `cached` (the provider's saved web content) or `disabled`. `allowed_domains`, `context_size` and `location` are forwarded to Codex's provider search tool; Claude Code enforces `allowed_domains` on its hosted `WebSearch`. The full option set is the [official contract](https://developers.openai.com/api/docs/guides/agents-api/tools/web-search).

Each search appears as a `web_search_call` output item, streamed through the `agent.output.*` events like any other item; citations arrive in the assistant's text in the provider's own format. Usage for the turn includes the search.

A session whose preset does not declare `webSearch`, or whose runtime has no hosted search, is refused at creation with `422 unsupported_capability`; the deployment decides which presets may reach the web. A delegated child keeps the parent's `web_search` tool only when the delegate preset resolves it the same way (a `nativeModel` connection with `webSearch: true` on a runtime that drives it); otherwise the tool is dropped for that child and the rest of the tools are inherited.

## Your own search as a function tool

A function tool is a client tool: the runtime emits a `required_action`, your code runs the search and submits the result. It works on every runtime and every model connection. `webSearch` from `cf-open-agents-api/tools` wraps a provider function into a validated tool definition: the model receives `{ query }`, your provider returns `{ title, url, snippet }[]` (at most 50, every `url` parseable), and the schema is checked on both sides.

```ts
import { webSearch } from "cf-open-agents-api/tools";

// Any search backend: a search API, an index, a crawler. It receives the abort signal
// of the turn, so a cancelled turn cancels the request.
const search = webSearch(async (query, signal) => {
  const response = await fetch(`${env.SEARCH_URL}?q=${encodeURIComponent(query)}`, {
    headers: { authorization: `Bearer ${env.SEARCH_KEY}` },
    signal,
  });
  const { results } = await response.json<{
    results: { title: string; url: string; snippet: string }[];
  }>();
  return results.slice(0, 10);
});

const session = await client.beta.agents.sessions.create({
  agent: { model: "opencode", tools: [search.spec] },
  environment: { type: "openai_hosted" },
});
const stream = client.beta.agents.sessions.stream(session.id, {
  input: "Find the Cloudflare Durable Objects documentation and cite the pages you used.",
  toolHandlers: {
    web_search: (args) =>
      search.call(args, {
        tenantId: tenant,
        sessionId: session.id,
        operationId: crypto.randomUUID(),
        signal: stream.controller.signal,
      }),
  },
});
for await (const event of stream)
  if (event.type === "agent.session.turn.output_text.delta") process.stdout.write(event.delta);
```

`search.spec` is the `{ type: "function", name: "web_search", ... }` entry for `agent.tools`; `search.call` validates the arguments, runs the provider and validates the results; `search.effect` is the same as an Effect for composition. To rename the tool, spread the definition and its `spec` with another `name`, as `knowledgeSearch` does. Give a session either the hosted tool or your own, not both with the same purpose.

Without the SDK's `toolHandlers`, poll the session until `status` is `requires_action`, run the search for each function call in `required_actions`, and submit an `agent.session.input.tool_result` with the call's `call_id` and `turn_id`; [function tools](service-binding.md#function-tools) shows that flow.

Two variations use the same shape:

- `knowledgeSearch(provider)` is the same tool named `knowledge_search` and described as a corpus search, for AI Search, Vectorize or any retrieval you own. A corpus is deliberately not presented to the model as the public web.
- With `defer_loading: true` on the tool, or `{ type: "tool_search" }` in the tools, the runtime loads the schema on demand instead of carrying it in every request; useful when search is one of many tools.

Your application owns authentication, rate limits, budgets and logging of the searches it runs; installing the helper grants the runtime nothing. A tool the model calls from generated code through [programmatic tool calling](environments-and-tools.md#let-the-model-orchestrate-tools-in-code) reaches your handler the same way.

## Search behind an MCP server

An MCP server that exposes a search tool needs no code in the session: declare it in `agent.tools` with `type: "mcp"`, list the tool in `allowed_tools`, and attach its credential through a Vault so the token never enters an agent definition or the sandbox. [Attach a credential to service-origin MCP](environments-and-tools.md#attach-a-credential-to-service-origin-mcp) is the complete example. Service-origin servers are called by the Worker with the Vault credential; environment-origin servers run inside the sandbox, which has no Internet egress of its own, so a search server there can only reach what the environment's network policy allows.

## When it does not work

| Symptom                                                                   | Cause                                                                                                        | Fix                                                                                          |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `422 unsupported_capability` at session creation with a `web_search` tool | The preset has no `webSearch: true`, or its runtime is OpenCode                                              | Enable it on a preset whose `model` is a `nativeModel` entry, or use a function tool         |
| `webSearch: true` on a preset but searches never happen                   | The preset's `model` is an `aiSDKModel` or `openAICompatibleModel` entry, which cannot carry the hosted tool | Move the preset to a `nativeModel` connection, or use a function tool                        |
| The tool works for the session but not for a delegated child              | The delegate preset does not resolve hosted search                                                           | Declare it on the delegate preset too, or accept that children search through function tools |
| The provider refuses the search with a 4xx                                | The provider's own policy or account limits                                                                  | The turn fails with the provider's code; see [turn outcomes](architecture.md#turn-outcomes)  |
| `web_search` function calls arrive but the results are rejected           | The provider returned more than 50 results or a `url` that does not parse                                    | Trim and normalize results in the provider function                                          |
