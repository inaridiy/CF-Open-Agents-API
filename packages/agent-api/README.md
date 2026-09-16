# cf-open-agents-api

**An unofficial, independent implementation of the OpenAI Agents API for Cloudflare Workers, running Codex, Claude Code or OpenCode against models you configure.**

Keep the official OpenAI client. Your Worker owns the API, the session state, the sandboxes and the model credentials. The runtimes run in Cloudflare Containers; Durable Objects hold the sessions; R2 holds checkpoints, workspaces and files. This package is not affiliated with OpenAI, Anthropic, the OpenCode project or Cloudflare; product names are used only to describe compatibility.

Targets `agents=v1` in `openai@7.15.0`. Pre-release: nothing has been published to npm yet. Read the [compatibility profile](https://github.com/inaridiy/CF-Open-Agents-API/blob/main/docs/compatibility.md) before integrating.

Every runtime supports hosted environments, files, skills, templates, MCP with Vault credentials, deferred tools, programmatic tool calling, images, steering, native subagents, reasoning and command streaming, usage and native checkpoint restore. Presets can delegate subagents to other runtimes, and sessions can be forked onto another preset. Hosted web search is available on Codex and Claude Code through a native model connection.

Running any harness needs the Docker images in the repository's `docker/` directory; see [deployment](https://github.com/inaridiy/CF-Open-Agents-API/blob/main/docs/deployment.md).

The recommended connection is another Worker handing its Service Binding to the OpenAI client as a custom `fetch`: [Service Binding guide](https://github.com/inaridiy/CF-Open-Agents-API/blob/main/docs/service-binding.md). [Direct RPC](https://github.com/inaridiy/CF-Open-Agents-API/blob/main/docs/rpc.md) and [hosted HTTP](https://github.com/inaridiy/CF-Open-Agents-API/blob/main/docs/http-api.md) are the other paths.

| Import                          | Purpose                                                                                                            |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `cf-open-agents-api`            | Wire schemas, types, tagged error classes, `ApiError`, runtime driver contracts, Effect helpers                    |
| `cf-open-agents-api/cloudflare` | `defineAgentWorker`, `createAgentService`, `AgentRPC`, `bearerTenant`, DO and Container classes, container drivers |
| `cf-open-agents-api/models`     | `nativeModel`, `aiSDKModel`, `openAICompatibleModel`, `createModelGateway`                                         |
| `cf-open-agents-api/tools`      | `defineTool`, search presets and immutable skill helpers                                                           |

The setup CLI, [`create-cf-open-agents-api`](https://www.npmjs.com/package/create-cf-open-agents-api), adds this package, its bindings, a composition and the Docker image snapshot to a Workers project: `pnpm dlx create-cf-open-agents-api@alpha init`. See the [library API](https://github.com/inaridiy/CF-Open-Agents-API/blob/main/docs/library-api.md) for `defineAgentWorker`, the factory options, RPC methods, peers and installation from a source checkout. The workspace examples run without an npm publication. Peers: `effect@3.22.2`, `openai@7.15.0`, and `ai@7.0.97` for the model entrypoint. Container support pins `@cloudflare/sandbox@0.13.0-next.751.1` with its matching image.

Apache-2.0. [Deployment](https://github.com/inaridiy/CF-Open-Agents-API/blob/main/docs/deployment.md) ·
[Security](https://github.com/inaridiy/CF-Open-Agents-API/blob/main/SECURITY.md) ·
[Changelog](https://github.com/inaridiy/CF-Open-Agents-API/blob/main/CHANGELOG.md) ·
[Releases](https://github.com/inaridiy/CF-Open-Agents-API/blob/main/docs/releasing.md)
