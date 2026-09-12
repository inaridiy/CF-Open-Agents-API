# CF-Open-Agents-API

An OSS Agents API built on Cloudflare Workers, SQLite Durable Objects, R2, and Containers.
Call it over HTTP with the OpenAI SDK, or through a typed Worker Service Binding.
The TypeScript package is `cf-open-agents-api`.

**Alpha.** Targets the `agents=v1` contract in `openai@7.15.0`. See the
[compatibility profile](docs/compatibility.md) for supported fields and limitations.
This is an independent implementation; it is not an OpenAI or Cloudflare product.

## How it works

```mermaid
flowchart LR
  Client --> API[Agent Worker]
  Caller[Caller Worker] -->|Service Binding| API
  API --> Catalog[TenantCatalogDO]
  API --> Session[SessionDO / SQLite + Kysely]
  Session --> Harness[HarnessDO / Codex Container]
  Harness -->|Native exec-server protocol| Sandbox[SandboxDO / Sandbox Container]
  Session --> AI[AIHarnessDO / AI SDK]
  Harness --> R2[Checkpoints / R2]
  Sandbox --> R2
  AI --> R2
```

SessionDO owns the durable input log, turns, events, required actions, and execution
state. A Container is replaceable compute. Native harness state and workspace
checkpoints are committed together before a completed turn becomes visible.
Unknown execution outcomes fail explicitly instead of silently replaying side effects.

## Develop

Requires Node **24+** and **pnpm 11.1.2**. Docker is required for the Container example.
The native Codex protocol tests additionally require **Codex 0.154.0** on `PATH`.
The Container smoke runner supports Linux/macOS and uses local port 8799.

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test:codex
```

`pnpm test` runs the production API/session implementation inside workerd with real
SQLite and a scripted execution fixture. `pnpm test:codex` runs real Codex binaries
against a local scripted Responses server. Neither command calls a paid model API.
`pnpm test:containers` additionally builds and runs the actual Worker and both
Containers, destroys the compute, and verifies R2 restore using a scripted model.

## Run the Worker example

```sh
pnpm build
cp examples/worker/.dev.vars.example examples/worker/.dev.vars
# Set API_TOKEN and OPENAI_API_KEY in that file.
pnpm dev
```

The example registers `coding` (Codex) and `assistant` (AI SDK / Workers AI). Their model mappings are
in [the Worker composition root](examples/worker/src/index.ts).
Local sandbox backups use Wrangler's emulated R2 binding.
Use `environment: { type: "none" }` with `assistant`. Workers AI calls use your
Cloudflare account, including during local development; the test suites use fixtures.
See [deployment](docs/deployment.md) for production R2 credentials and sizing.

```ts
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://localhost:8787/v1",
  apiKey: process.env.AGENT_API_TOKEN,
});
const session = await client.beta.agents.sessions.create({
  agent: { model: "coding" },
  environment: { type: "openai_hosted" },
  input: "Create a small TypeScript project in /workspace.",
});
console.log(session.id);
```

`openai_hosted` is the compatibility protocol's spelling for managed compute;
**this deployment provisions Cloudflare Containers**. `none` disables the execution
environment. Unsupported environment provisioning fields are rejected.

Retrieve the session until it becomes `idle`, `requires_action`, or `failed`;
inspect `sessions.items.list(session.id)` and `sessions.turns.list(session.id)`.
For one streamed turn, use `client.beta.agents.sessions.stream(session.id, { input: "Hello" })`
on an idle session. It subscribes before submitting input and can run tool handlers.
Disconnecting does not cancel execution.

## Service Binding

Bind a caller Worker's `AGENTS` service to the deployed Worker. HTTP and RPC share
the same session implementation. Service Bindings are trusted deployment boundaries:
the calling Worker authenticates its own users and supplies their tenant IDs.

```ts
const session = await env.AGENTS.createSession("tenant-123", {
  agent: { model: "coding" },
  environment: { type: "none" },
}, "creation-key");
await env.AGENTS.submitEvents("tenant-123", session.id, [{
  type: "agent.session.input.message",
  input: [{ role: "user", content: [{ type: "input_text", text: "Hello" }] }],
}], "message-key");
```

## Extend

- [Harnesses and models](docs/extending.md): Codex, AI SDK model instances, Workers AI,
  and the driver contract for additional harnesses.
- [Tools and assets](docs/extending.md#tools-and-assets): typed tools, web/corpus search,
  and immutable skill bundles.
- [Architecture](docs/architecture.md): design rationale and future capabilities.
- [Contributing](CONTRIBUTING.md): code layout, validation, and compatibility changes.

## Commands

| Command | Purpose |
| --- | --- |
| `pnpm check` | Documentation checks, typecheck, lint, tests and builds |
| `pnpm check:docs` | Verify project names, entrypoints, commands, bindings and image pins |
| `pnpm typecheck` | Check TypeScript without emitting files |
| `pnpm lint` | Check formatting and lint rules |
| `pnpm test` | Worker, SQLite, streaming, AI SDK and asset tests |
| `pnpm test:codex` | Native Codex protocol and checkpoint tests |
| `pnpm test:containers` | Two-Container execution, skill provisioning and R2 restore |
| `pnpm build` | ESM JavaScript and declaration files |
| `pnpm dev` | Local Worker and Containers |
| `pnpm types` | Regenerate example binding/runtime types |
| `pnpm deploy:check` | Build images and run Wrangler's deployment dry run |
| `pnpm format` | Format code and organize imports |

## License

Apache-2.0. Contributions are welcome; no contributor agreement is required.
