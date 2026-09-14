# cf-open-agents-api

**An open-source implementation of the OpenAI Agents API, with configurable runtimes and models.**
Keep the official OpenAI client; host your API and session state on Cloudflare.
Choose Codex, Claude Code, or OpenCode and connect deployment-owned model presets.
Every runtime supports environments, files, skills, MCP, programmatic tool calling,
image input, reasoning/command streaming and usage; Codex adds configured web search
through a supporting native Responses connection. Presets can delegate subagents to
other runtimes, and sessions can be forked onto another preset.

Alpha, targeting `agents=v1` in `openai@7.15.0`.
Check the [compatibility profile](https://github.com/inaridiy/CF-Open-Agents-API/blob/main/docs/compatibility.md) for current guarantees.
This is an independent implementation, unaffiliated with OpenAI or Cloudflare.

The recommended connection is another Worker supplying its Service Binding as the OpenAI client's custom `fetch`.
Start with the [Service Binding guide](https://github.com/inaridiy/CF-Open-Agents-API/blob/main/docs/service-binding.md).
[Direct RPC](https://github.com/inaridiy/CF-Open-Agents-API/blob/main/docs/rpc.md) and
[hosted HTTP](https://github.com/inaridiy/CF-Open-Agents-API/blob/main/docs/http-api.md) are also supported connection paths.

| Import                          | Purpose                                                                  |
| ------------------------------- | ------------------------------------------------------------------------ |
| `cf-open-agents-api`            | Wire schemas, types, errors and runtime driver contracts                 |
| `cf-open-agents-api/cloudflare` | Worker/DO factory, typed RPC, Container and environment drivers          |
| `cf-open-agents-api/models`     | AI SDK models, OpenAI-compatible connections and native protocol presets |
| `cf-open-agents-api/tools`      | Function tools, search presets and immutable skill bundles               |

See the [library API](https://github.com/inaridiy/CF-Open-Agents-API/blob/main/docs/library-api.md)
for factory options, RPC methods, peers and installation from a source checkout/local tarball.
The workspace examples run without publishing this package to npm.
Development pins Effect 3.22.2, OpenAI SDK 7.15.0 and AI SDK 7.0.97.
Container support pins `@cloudflare/sandbox@0.13.0-next.751.1` with its matching image.

Apache-2.0. [Deployment](https://github.com/inaridiy/CF-Open-Agents-API/blob/main/docs/deployment.md) ·
[Security](https://github.com/inaridiy/CF-Open-Agents-API/blob/main/SECURITY.md) ·
[Releases](https://github.com/inaridiy/CF-Open-Agents-API/blob/main/docs/releasing.md)
