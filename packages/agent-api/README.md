# cf-open-agents-api

**An unofficial, independent implementation of the OpenAI Agents API for Cloudflare Workers, running Codex, Claude Code or OpenCode against models you configure.**

Keep the official OpenAI client. Your Worker owns the API, the session state, the sandboxes and the model credentials. The runtimes run in Cloudflare Containers; Durable Objects hold the sessions; R2 holds checkpoints, workspaces and files. This package is not affiliated with OpenAI, Anthropic, the OpenCode project or Cloudflare; product names are used only to describe compatibility.

## Get started

The setup CLI creates a Worker with this library and a demo app, or adds the library to a Worker you already have. Node 24, pnpm and a running Docker engine are the prerequisites; Workers AI needs no provider key.

```sh
mkdir my-agents && cd my-agents
pnpm dlx create-cf-open-agents-api@alpha init
pnpm install && pnpm exec wrangler login && pnpm dev
```

Then open <http://localhost:8787>. The [QuickStart](https://github.com/inaridiy/CF-Open-Agents-API/blob/main/docs/quickstart.md) explains what the demo does and how to add the API to an existing Worker; the CLI package is [`create-cf-open-agents-api`](https://www.npmjs.com/package/create-cf-open-agents-api).

## Use it from your Worker

The generated project binds this Worker's `Agents` entrypoint as the `AGENTS` Service Binding. Give the official client `tenantFetch` as its `fetch`: the binding is the credential, the trusted Worker names the tenant, and no bearer token crosses it.

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
```

`agents.internal` is a routing label; the request never leaves the binding. `codex` is a preset the composition defines; clients name presets and never see provider URLs or keys. Derive the tenant from your own verified identity, never from a request body. The [Service Binding guide](https://github.com/inaridiy/CF-Open-Agents-API/blob/main/docs/service-binding.md) covers streaming, function tools and cancellation; [direct RPC](https://github.com/inaridiy/CF-Open-Agents-API/blob/main/docs/rpc.md) and [hosted HTTP](https://github.com/inaridiy/CF-Open-Agents-API/blob/main/docs/http-api.md) are the other paths.

## What it provides

Targets `agents=v1` in `openai@7.15.0`. Every runtime supports hosted environments, files, skills, templates, MCP with Vault credentials, deferred tools, programmatic tool calling, images, steering, native subagents, reasoning and command streaming, usage and native checkpoint restore. Presets can delegate subagents to other runtimes, Claude Code presets map their subagent tiers to gateway models (`tiers`), and sessions can be forked onto another preset. Hosted web search is available on Codex and Claude Code through a native model connection. Read the [compatibility profile](https://github.com/inaridiy/CF-Open-Agents-API/blob/main/docs/compatibility.md) before integrating.

| Import                          | Purpose                                                                                                                           |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `cf-open-agents-api`            | Wire schemas, types, tagged error classes, `ApiError`, runtime driver contracts, Effect helpers                                   |
| `cf-open-agents-api/cloudflare` | `defineAgentWorker`, `createAgentService`, `AgentRPC`, `bearerTenant`, `tenantFetch`, DO and Container classes, container drivers |
| `cf-open-agents-api/models`     | `nativeModel`, `aiSDKModel`, `openAICompatibleModel`, `createModelGateway`                                                        |
| `cf-open-agents-api/tools`      | `defineTool`, search presets and immutable skill helpers                                                                          |

Running any harness needs the Docker images in the repository's `docker/` directory, which the CLI snapshots into the project; see [deployment](https://github.com/inaridiy/CF-Open-Agents-API/blob/main/docs/deployment.md). The [library API](https://github.com/inaridiy/CF-Open-Agents-API/blob/main/docs/library-api.md) documents `defineAgentWorker`, the factory options, the RPC methods, peers and installation from a source checkout. Peers: `effect@3.22.2`, `openai@7.15.0`, and `ai@7.0.97` for the model entrypoint. Container support pins `@cloudflare/sandbox@0.13.0-next.751.1` with its matching image. Pre-release: versions publish under the npm `alpha` dist-tag.

Apache-2.0. [Deployment](https://github.com/inaridiy/CF-Open-Agents-API/blob/main/docs/deployment.md) ·
[Security](https://github.com/inaridiy/CF-Open-Agents-API/blob/main/SECURITY.md) ·
[Changelog](https://github.com/inaridiy/CF-Open-Agents-API/blob/main/CHANGELOG.md) ·
[Releases](https://github.com/inaridiy/CF-Open-Agents-API/blob/main/docs/releasing.md)
