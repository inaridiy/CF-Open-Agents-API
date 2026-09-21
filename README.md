# CF-Open-Agents-API

**An unofficial, independent implementation of the OpenAI Agents API that runs Codex, Claude Code or OpenCode on your own Cloudflare account, against models you configure.**

Keep the official OpenAI client. Point it at your Worker. The Worker owns the API, the session state, the sandboxes and the model credentials.

## What it is and is not

- It implements the `agents=v1` surface of `openai@7.15.0`: agents, sessions, turns, items, streaming, environments, files, skills, artifacts, subagents, MCP and vaults. The [compatibility profile](docs/compatibility.md) lists what is implemented, what differs and what is missing.
- It runs the native agent runtimes (Codex `0.154.0`, Claude Agent SDK `0.3.268`, OpenCode `1.18.30`) in Cloudflare Containers. Each runtime keeps its own agent loop; this project supplies sandboxes, tools, durability and the API around it.
- It is not affiliated with, endorsed by or supported by OpenAI, Anthropic, the OpenCode project or Cloudflare. "OpenAI", "Codex", "Claude", "Claude Code", "OpenCode" and "Cloudflare" are trademarks of their owners and are used here only to describe compatibility.
- It does not use Cloudflare's `agents` npm package. The name describes the API it implements, not a dependency.
- It is pre-release software. Versions publish under the npm `alpha` dist-tag, never `latest`. Expect breaking changes until `1.0`.

## Who it is for

- Teams that want the Agents API programming model (sessions, turns, hosted environments, tool results) with their own choice of runtime and model provider.
- Teams that need session state, workspaces and provider keys to stay inside one Cloudflare account.
- Contributors interested in durable agent execution on Durable Objects, Containers and R2.

If you only need a single model call with tools, this project is more than you need. If you need OpenAI's hosted environments exactly as OpenAI runs them, use OpenAI.

## Quick start

The setup CLI creates a Worker with the API and a small demo app: a prompt form, a job page that streams the turn as it runs, and a zip of the files the agent wrote. Node 24, pnpm and a running Docker engine are the prerequisites; Workers AI needs no provider key.

```sh
mkdir my-agents && cd my-agents
pnpm dlx create-cf-open-agents-api@alpha init     # choose the demo template and a provider; Workers AI needs no key
pnpm install
pnpm exec wrangler login
pnpm dev                                            # or pnpm dev:rootless when init offered it
```

Open <http://localhost:8787>, type a prompt, pick a preset and press Build. The [QuickStart](docs/quickstart.md) explains what happens under the hood, where the presets and keys live, and the first questions that come up.

![A finished job with the transcript, thinking and the zip download](docs/images/demo-job.png)

To add the API to a Worker you already have, run `init` in its directory instead; it writes the bindings into `wrangler.jsonc`, the composition into `src/agents.ts` and the Docker build context into `.cf-open-agents-api/`:

```sh
pnpm dlx create-cf-open-agents-api@alpha init
pnpm install
pnpm exec wrangler login
pnpm dev
```

Then hand the `AGENTS` binding to the official client; see [Use it from your Worker](#use-it-from-your-worker) below.

## Architecture

```mermaid
flowchart LR
  Client["Your Worker or HTTP client<br/>(official OpenAI SDK)"]
  subgraph Account["Your Cloudflare account"]
    Worker["AgentWorker<br/>auth, validation, routing, RPC"]
    Catalog["TenantCatalogDO<br/>agents, templates, skills, vaults, files"]
    Session["SessionDO<br/>turns, items, event log (SQLite)"]
    Harness["HarnessDO + Harness Container<br/>supervisor running Codex, Claude Code or OpenCode"]
    Sandbox["SandboxDO + Sandbox Container<br/>/workspace, shell, files, exec-server"]
    Gateway["Models entrypoint<br/>private model gateway with provider keys"]
    Loader["Dynamic Worker (CODE_LOADER)<br/>programmatic tool code"]
    R2[("R2<br/>native checkpoints, workspace backups,<br/>input files, skills, artifacts")]
  end
  Provider["Model provider<br/>OpenAI, Anthropic, Workers AI, OpenAI-compatible"]
  Client -->|Service Binding or HTTPS| Worker
  Worker --> Catalog
  Worker --> Session
  Session -->|start, poll, control, checkpoint| Harness
  Harness -->|workspace tools| Sandbox
  Harness -->|model.internal| Gateway
  Gateway --> Provider
  Harness --> Loader
  Harness --> R2
  Sandbox -->|backups| R2
```

One Worker exports every class. Each session has its own SessionDO, HarnessDO and SandboxDO. The harness container never has Internet access; model traffic leaves only through the private gateway, which holds the provider credentials. See [architecture](docs/architecture.md) for the durability rules.

## Prerequisites and costs

| Need                    | Detail                                                                                                                                                                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node                    | 24 or newer. CI uses `24.15.0`.                                                                                                                                                                                                 |
| pnpm                    | `11.1.2`, the pinned `packageManager`.                                                                                                                                                                                          |
| Docker                  | A running engine for `pnpm dev`, `pnpm dev:caller`, `pnpm test:containers` and `pnpm deploy:check`. The two images in `docker/` need roughly 5 GB; the first build installs Node, Codex and OpenCode and takes several minutes. |
| Cloudflare account      | Workers Paid plan (Containers require it), Durable Objects with SQLite, R2, and Workers AI if you use the `workers` preset.                                                                                                     |
| Model credentials       | An OpenAI API key for the `codex`, `claude` and `opencode` presets, or nothing beyond your Cloudflare account for the `workers` preset (Workers AI).                                                                            |
| Codex `0.154.0` on PATH | Only for `pnpm test:codex` and `pnpm test:harnesses`. pnpm installs the pinned Claude Agent SDK and OpenCode.                                                                                                                   |
| `python3`               | Only for `pnpm test:containers`; the smoke builds a plugin archive with it.                                                                                                                                                     |

What you pay for in production: Container run time (a harness container on the `basic` instance type and a sandbox container on `standard-1`, both idle-stopped after 10 minutes), R2 storage for checkpoints and workspace backups (backups expire after 30 days), Durable Object requests and storage, and whatever your model provider bills. The example keeps a session's sandbox alive between turns, so a chatty session pays for one container pair, not one per turn. Nothing in this repository sets a spending limit for you; see [deployment](docs/deployment.md) for the cost model and scaling knobs.

## Add it to your Worker

The setup CLI, [`create-cf-open-agents-api`](packages/create-cf-open-agents-api/README.md), adds the API to a Workers project you already have (a Vite + `@cloudflare/vite-plugin` app, a Hono Worker, anything Wrangler deploys) or creates a new Worker for it, with the demo app or the API alone. It writes the bindings into `wrangler.jsonc` without losing your comments, generates the composition from your provider and runtime choices (presets, the gateway registry, `tiers` for Claude Code subagents, `authenticate`), snapshots the Docker build context into `.cf-open-agents-api/`, and creates `.dev.vars` with a random token. On a rootless Docker engine it offers a `dev:rootless` script. The commands are in the [Quick start](#quick-start); `--yes` takes the defaults.

Your Worker reaches the API through its own `AGENTS` binding: the official client with `tenantFetch` (below) is the default, the typed RPC methods are the typed path for a trusted Worker, and a forwarded route (`app.all("/v1/*", (c) => c.env.AGENTS.fetch(c.req.raw))`) is for callers that hold the bearer token. `create-cf-open-agents-api setup` creates the R2 buckets and puts the production secrets, `doctor` checks the toolchain and the configuration.

## First run from this repository

The `workers` preset runs Codex against Workers AI. Workers AI has no local emulator: `wrangler dev` sends `AI` binding calls to your account, so you must be logged in (`wrangler login`) and the calls count against your Workers AI usage. `examples/worker` is the Worker this repository deploys and the CLI's minimal template; `examples/demo` is the demo template; `examples/caller` is a Worker that consumes the API over a Service Binding.

```sh
git clone https://github.com/inaridiy/CF-Open-Agents-API.git
cd CF-Open-Agents-API
pnpm install --frozen-lockfile
pnpm bootstrap        # writes the worker, demo and caller .dev.vars with one random API_TOKEN
# Leave OPENAI_API_KEY empty if you have no OpenAI key: presets are built only
# when a session selects them, and the `workers` preset never calls OpenAI.
pnpm dev:caller       # builds the library first, then both Docker images
```

Wrangler builds both Docker images, starts the Agent Worker and starts the caller on `http://localhost:8788`. Then:

```sh
export AGENT_API_TOKEN=... # the API_TOKEN from examples/worker/.dev.vars
curl http://localhost:8788/sdk/sessions \
  -H "Authorization: Bearer $AGENT_API_TOKEN" \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: first-report' \
  -d '{"agent":{"model":"workers"},"environment":{"type":"openai_hosted"},"input":"Write /workspace/outputs/report.txt with a short greeting, then read it back and report the result."}'
```

Poll `GET /sdk/sessions/<id>` with the same header until `session.status` is `idle`, `requires_action` or `failed`. The response includes the items and turns. `DELETE /sdk/sessions/<id>` removes the session. The [caller source](examples/caller/src/index.ts) implements this journey through both the SDK (`/sdk`) and typed RPC (`/rpc`).

Use `"model":"codex"` with a real `OPENAI_API_KEY` for the full Codex experience (native Responses, images, hosted web search, structured output). Use `claude` or `opencode` to run the other runtimes against the same key through the portable AI SDK adapter.

## Use it from your Worker

Bind the Agent Worker as a service named `AGENTS` (the CLI writes a self binding to the `Agents` entrypoint), then give the official client `tenantFetch` as its `fetch`. The binding is the credential: the trusted Worker names the tenant, and no bearer token crosses it.

```ts
import { tenantFetch } from "cf-open-agents-api/cloudflare";
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: "service-binding", // the SDK requires a value; the API never reads it on this path
  baseURL: "https://agents.internal/v1",
  fetch: tenantFetch(env.AGENTS, "default"),
});
const session = await client.beta.agents.sessions.create(
  { agent: { model: "codex" }, environment: { type: "openai_hosted" } },
  { headers: { "Idempotency-Key": "report-session-1" } },
);
for await (const event of client.beta.agents.sessions.stream(session.id, {
  input: "Create /workspace/outputs/report.txt explaining this project, then summarize it.",
  idempotencyKey: "report-turn-1",
})) {
  if (event.type === "agent.session.turn.output_text.delta") console.log(event.delta);
  if (event.type === "agent.session.turn.failed" && !event.turn.subagent_id)
    throw new Error(event.turn.error?.message ?? "Agent turn failed");
}
```

`agents.internal` is a routing label; the request never leaves the Service Binding. `openai_hosted` is the SDK's wire name and selects a Cloudflare sandbox here. `codex` is a preset your deployment defines; clients pick presets and never see provider URLs or keys. `"default"` is the tenant: derive it from your own verified identity, never from a request body. A caller that only holds the bearer token uses `env.AGENTS.fetch` with `apiKey: env.API_TOKEN` instead and passes through the HTTP authenticator.

| Connection                                       | Start here                                                                |
| ------------------------------------------------ | ------------------------------------------------------------------------- |
| The demo, the first session, the first questions | [QuickStart](docs/quickstart.md)                                          |
| Another Worker, Service Binding, OpenAI client   | [Service Binding guide](docs/service-binding.md)                          |
| Another Worker, typed RPC without HTTP           | [RPC guide](docs/rpc.md)                                                  |
| Node, Python or anything else over HTTPS         | [HTTP guide](docs/http-api.md)                                            |
| Adding the API to your Worker with the CLI       | [create-cf-open-agents-api](packages/create-cf-open-agents-api/README.md) |
| Embedding the library in your own Worker         | [Library API](docs/library-api.md)                                        |
| Files, skills, templates, MCP, subagents, forks  | [Environments and tools](docs/environments-and-tools.md)                  |
| Presets, model adapters, custom drivers          | [Extending](docs/extending.md)                                            |

## How a turn works

1. You submit input. SessionDO writes the turn and its input items in one SQLite transaction and arms a Durable Object alarm. The response is `204`; the work has not started yet.
2. The alarm runs the reconciler. It asks the harness driver to start. HarnessDO checks whether the running sandbox still holds the workspace the turn must start from. If it does, the sandbox is reused as is. If not, the sandbox is destroyed, the last committed backup is restored from R2, and the environment configuration (network policy, packages, files, skills, setup commands) is applied again. The job is then posted to the supervisor in the harness container.
3. The native runtime runs its loop. Model calls go through `model.internal` to the private gateway. Shell and file tools run in the sandbox container. Function calls you declared come back as `required_actions`; you answer them with `agent.session.input.tool_result`. Input sent while the turn runs is steered into the live turn.
4. The reconciler long-polls the supervisor and appends events to the session's event log; each poll returns as soon as the runtime produces something, so streaming follows the runtime's pace rather than the alarm interval. SSE listeners read from that log, so a dropped stream loses nothing and never cancels the turn.
5. When the runtime finishes, the turn enters `checkpointing`. The supervisor captures the runtime's home directory, HarnessDO stores it in R2, backs up `/workspace`, and publishes `/workspace/outputs` as artifacts. The turn becomes `completed` only after those references are committed.
6. A failed turn returns the session to `idle` with `session.error` set, and the next turn restores the last committed checkpoint. Only an outcome nobody can confirm (`outcome_unknown`, `programmatic_execution_uncertain`) leaves the session `failed`; fork it to continue.

## Compose the Worker with `defineAgentWorker`

One call builds everything the deployment exports: the `Agents` entrypoint (HTTP routes and typed RPC), the `Models` gateway entrypoint, and the four Durable Object classes. The setup CLI writes this file for you; this is the whole of it, with the three options you will actually edit:

```ts
import {
  type AgentBindings,
  bearerTenant,
  type ContainerBindings,
  defineAgentWorker,
} from "cf-open-agents-api/cloudflare";
import { aiSDKModel, nativeModel } from "cf-open-agents-api/models";
import { createOpenAI } from "@ai-sdk/openai";

interface Bindings extends AgentBindings, ContainerBindings {
  API_TOKEN: string;
  OPENAI_API_KEY: string;
}

export const { Agents, Models, SessionDO, TenantCatalogDO, HarnessDO, SandboxDO, ContainerProxy } =
  defineAgentWorker<Bindings>({
    // Presets: the names clients send as `agent.model`. Each picks a native runtime
    // (`harness`) and a gateway entry (`model`); a session pins both at creation.
    agents: {
      codex: { harness: "codex", model: "codex", webSearch: true, delegates: ["claude"] },
      claude: { harness: "claude-code", model: "primary", tiers: { haiku: "fast" } },
    },
    // The private gateway: deployment-owned names → provider connections. Keys stay here;
    // runtimes and sandboxes only ever see the name. Each entry is built on first use.
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
    }),
    // Who may call the HTTP API, and as which tenant. Service Binding callers name the
    // tenant themselves (`tenantFetch`) and never pass through this function.
    authenticate: (request, env) => bearerTenant(request, env.API_TOKEN, "default"),
  });
export default Agents;
```

- `agents` are presets. Clients choose a preset and never see provider URLs, model ids or keys. `delegates` lists the presets a session may start subagents on when `multi_agent` is enabled; `tiers` names the gateway entries a Claude Code subagent's `haiku`, `sonnet` and `opus` request resolves to.
- `models` is the gateway registry. `nativeModel` passes a provider's own protocol through unchanged, so reasoning state, images and hosted tools survive. `aiSDKModel` and `openAICompatibleModel` translate any AI SDK or Chat Completions model, including Workers AI, into what the runtime speaks.
- `authenticate` maps an HTTP request to a tenant. Replace `bearerTenant` with your own verification (Access, JWT, session cookie) for multi-tenant deployments.

`harnesses`, `environments`, `objects`, `maxTurnMs` and `pollIntervalMs` have defaults; the [Library API](docs/library-api.md#composition) lists them. Environments (network policy, packages, files, skills, setup commands) and tools (function tools, MCP servers with Vault credentials, programmatic tool calling) are configured per session or through templates; see [Environments and tools](docs/environments-and-tools.md).

### Enable hosted web search

Web search is a hosted tool of the model provider, so it needs two things: a preset that declares it, and a client that asks for it.

1. The preset's `model` must be a `nativeModel` entry (the provider's own protocol) and the preset sets `webSearch: true`. Codex gets the Responses search tool, Claude Code gets Anthropic's hosted `WebSearch`. The portable `aiSDKModel` and `openAICompatibleModel` adapters cannot carry hosted search, and OpenCode has none; there, expose search as a function tool.
2. The client adds the tool to the session's agent:

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

`mode` is `live` (the default), `cached`, or `disabled`; `allowed_domains`, `context_size` and `location` are forwarded to Codex and `allowed_domains` is enforced on Claude Code. A preset without `webSearch: true` rejects the tool, so a deployment decides which presets may reach the web. `GET /cf/v1/capabilities` shows the flag per preset. [Web search](docs/web-search.md) compares hosted search with a search of your own as a function tool or an MCP server, and shows both.

## Develop

`packages/agent-api` is the library, `packages/supervisor` the Node process that drives the native runtimes inside the harness container, `packages/create-cf-open-agents-api` the setup CLI, `examples/worker` the deployable composition (and the CLI's minimal template), `examples/demo` the demo app (the CLI's demo template) and `examples/caller` a consuming Worker. Local suites use scripted models and need no provider credentials.

| Command                   | Purpose                                                                 |
| ------------------------- | ----------------------------------------------------------------------- |
| `pnpm bootstrap`          | Write the worker, demo and caller `.dev.vars` files with one API token  |
| `pnpm dev:caller`         | Run the caller and its Agent Worker together (caller on localhost:8788) |
| `pnpm dev`                | Run the Agent Worker alone on localhost:8787                            |
| `pnpm check`              | Docs, harness, scripts, types, lint, Worker tests and build             |
| `pnpm check:docs`         | Documented commands, exports, bindings and image pins agree             |
| `pnpm check:harness`      | Documentation links, agent entrypoints and skill provenance             |
| `pnpm test:scripts`       | Unit tests of the development scripts                                   |
| `pnpm test:cli`           | The setup CLI against fixture projects, rendered compositions typecheck |
| `pnpm typecheck`          | TypeScript with Effect language-service diagnostics                     |
| `pnpm lint`               | Type-aware oxlint and oxfmt checks through ultracite                    |
| `pnpm format`             | Fix lint findings and formatting                                        |
| `pnpm effect:diagnostics` | Effect language-service diagnostics for the whole project               |
| `pnpm test`               | Worker, SQLite, SDK, Service Binding and asset tests in workerd         |
| `pnpm test:codex`         | Real Codex with a scripted model endpoint                               |
| `pnpm test:harnesses`     | All three native runtimes, the model gateway and history recovery       |
| `pnpm test:containers`    | Real local Containers and R2 recovery with scripted inference           |
| `pnpm test:package`       | Pack the library and typecheck a consumer against it                    |
| `pnpm build`              | Build ESM and declaration files                                         |
| `pnpm types`              | Generate the binding types of the three example Workers                 |
| `pnpm deploy:check`       | Dry-run the three example deployments and build the images              |

See [CONTRIBUTING.md](CONTRIBUTING.md) for which checks a change needs, [deployment](docs/deployment.md) for production and [known issues](docs/known-issues.md) for diagnostics you may see in local runs.

## License

Apache-2.0. Vendored development skills keep their own licenses; see [NOTICE](NOTICE).
[Changelog](CHANGELOG.md) · [Security](SECURITY.md) · [Code of conduct](CODE_OF_CONDUCT.md) · [Releasing](docs/releasing.md)
