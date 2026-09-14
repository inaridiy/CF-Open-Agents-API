# CF-Open-Agents-API

**An open-source implementation of the OpenAI Agents API—with your choice of runtime and model.**
Keep the OpenAI client. Run Codex, Claude Code, or OpenCode against models you configure.
Host the API, session state, and execution environments in your own Cloudflare account.

**Alpha.** Targets `agents=v1` in `openai@7.15.0`; Codex compatibility is the first priority.
Check the [compatibility profile](docs/compatibility.md) before integrating.
This is an independent implementation, unaffiliated with OpenAI or Cloudflare.

## Use it from your Worker

Bind an `AGENTS` service to your Agent Worker, then give its `fetch` to the official OpenAI client:

```ts
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "https://agents.internal/v1",
  apiKey: env.API_TOKEN,
  fetch: (input, init) => env.AGENTS.fetch(new Request(input, init)),
});
const session = await client.beta.agents.sessions.create({
  agent: { model: "coding" },
  environment: { type: "openai_hosted" },
}, { headers: { "Idempotency-Key": "report-session-1" } });
for await (const event of client.beta.agents.sessions.stream(session.id, {
  input: "Create /workspace/outputs/report.txt explaining this project, then summarize it.",
  idempotencyKey: "report-turn-1",
})) {
  if (event.type === "agent.session.turn.output_text.delta") console.log(event.delta);
  if (event.type === "agent.session.turn.failed" && !event.turn.subagent_id) throw new Error("Agent turn failed");
}
```

The hostname is a routing label: requests travel through the Service Binding.
`API_TOKEN` authenticates your API; model credentials stay in its private gateway.
The protocol spelling `openai_hosted` selects **Cloudflare compute** in this implementation.
`coding` is a deployment-owned preset; change its runtime/model mapping to fit your application.

| Connection | Start here |
| --- | --- |
| **Another Worker → Service Binding → OpenAI client** | [Recommended guide](docs/service-binding.md) |
| Another Worker → direct typed RPC | [RPC guide](docs/rpc.md) |
| Node, Python, or another service → hosted HTTP API | [HTTP guide](docs/http-api.md) |
| Embed/configure the library | [Library API](docs/library-api.md) |

## Try the complete Worker example

Requires [Node 24+](https://nodejs.org/en/download), [pnpm 11.1.2](https://pnpm.io/installation),
and a running [Docker engine](https://docs.docker.com/engine/install/) with room for both images.
The Sandbox SDK and image are pinned together to `0.13.0-next.751.1`.

```sh
git clone https://github.com/inaridiy/CF-Open-Agents-API.git
cd CF-Open-Agents-API
pnpm install --frozen-lockfile
pnpm build
cp examples/worker/.dev.vars.example examples/worker/.dev.vars
cp examples/caller/.dev.vars.example examples/caller/.dev.vars
# Put the same unpredictable API_TOKEN (at least 32 characters) in both files.
# Put OPENAI_API_KEY only in examples/worker/.dev.vars.
pnpm dev:caller
```

Repository access is required while this repository remains private.
The caller runs at `http://localhost:8788`; Wrangler also starts its Agent Worker binding.
This example calls real model providers. Workers AI also uses your Cloudflare account during local development.

1. Set `AGENT_API_TOKEN` in your shell to the example's `API_TOKEN`.
2. Create a task and keep the returned session `id`:

   ```sh
   curl http://localhost:8788/sdk/sessions \
     -H "Authorization: Bearer $AGENT_API_TOKEN" \
     -H 'Content-Type: application/json' -H 'Idempotency-Key: first-report' \
     -d '{"agent":{"model":"coding"},"environment":{"type":"openai_hosted"},"input":"Write /workspace/outputs/report.txt with a short greeting, then read it and report the result."}'
   ```

3. `GET /sdk/sessions/<id>` with the same authorization header until `session.status` is `idle`, `requires_action`, or `failed`.
   The response includes items and turns: a successful run has an assistant answer and a completed turn.
   A function call pauses at `requires_action`; [submit its result](docs/service-binding.md#function-tools) to continue.
4. `DELETE /sdk/sessions/<id>` after the turn stops to remove the session.

The [caller source](examples/caller/src/index.ts) implements that journey through both `/sdk` and `/rpc`.
Use a new idempotency key for a new task; retain a key when retrying the same request.

See [environments, tools, subagents and forks](docs/environments-and-tools.md) for files,
skills, artifacts, MCP, programmatic tool calling, cross-runtime delegation and forks.
All three runtimes accept image input and rich function results and stream reasoning
summaries, command output and usage; Codex adds configured Web search.
See the [input and streaming examples](docs/environments-and-tools.md#images-web-search-and-streamed-progress).

## What you control

Register runtime/model presets, provide tools, and configure environments in your own deployment.
Clients select those presets; they do not receive provider credentials or choose arbitrary binaries.
A preset may list the presets it can delegate subagents to, so one session can
combine runtimes in a shared workspace, and a session can be forked onto another preset.
[Configure harnesses and models](docs/extending.md) for provider connections and their supported features.

The Agent Worker routes to tenant catalogs and session Durable Objects.
Native harness Containers run the agent loops; separate Sandbox Containers run workspace commands.
SQLite stores turns and events. R2 stores conversation checkpoints, workspace backups, and published files.
A completed turn commits its checkpoints before it becomes visible as complete.
See [architecture](docs/architecture.md) for recovery and execution limits.

## Develop

`packages/agent-api` contains the library, `packages/supervisor` the native runtime adapters,
`examples/worker` the API deployment, and `examples/caller` the consuming Worker.
Native tests need **Codex 0.154.0** on `PATH`; pnpm installs the pinned Claude/OpenCode runtimes.
Local test suites use scripted inference and need no production credentials.

| Command | Purpose |
| --- | --- |
| `pnpm dev:caller` | Run the caller and its Agent Worker Service Binding |
| `pnpm dev` | Run the Agent Worker directly on localhost:8787 |
| `pnpm check` | Documentation, harness, scripts, types, lint, Worker tests, build |
| `pnpm check:docs` | Verify documented commands, exports, bindings and pins |
| `pnpm check:harness` | Check documentation links and development instructions |
| `pnpm test:scripts` | Check development scripts |
| `pnpm test:package` | Install and typecheck the packed library |
| `pnpm typecheck` | Check TypeScript |
| `pnpm lint` | Check formatting and lint rules |
| `pnpm test` | Worker, SQLite, SDK, Service Binding and asset tests |
| `pnpm test:codex` | Real Codex with a scripted model endpoint |
| `pnpm test:harnesses` | All three native runtimes, model gateway and recovery |
| `pnpm test:containers` | Real local Containers and R2 recovery with scripted inference |
| `pnpm build` | Build ESM and declaration files |
| `pnpm types` | Generate example Worker binding types |
| `pnpm deploy:check` | Check deployment bundles and images without deploying |
| `pnpm format` | Format code and imports |

See [deployment](docs/deployment.md) for hosting, [contributing](CONTRIBUTING.md) for validation,
and [library API](docs/library-api.md) for installing from a source checkout.

## License

Apache-2.0. Bundled development skills retain their licenses in [NOTICE](NOTICE).
[Changelog](CHANGELOG.md) · [Security](SECURITY.md) · [Release instructions](docs/releasing.md)
