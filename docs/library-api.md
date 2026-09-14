# Library API

`cf-open-agents-api` implements the OpenAI Agents API using configurable native runtimes and model connections.
Use the official SDK over a [Service Binding](service-binding.md) or [HTTP](http-api.md), or call the [typed RPC surface](rpc.md).

## Install from source

While distribution remains private, use the workspace examples or build a local package:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm --filter cf-open-agents-api pack --pack-destination /tmp/cf-open-agents-package
```

Install the resulting tarball in your consuming project with `pnpm add /absolute/path/to/the.tgz`.
Install the declared peers: `effect@3.22.2`, `openai@7.15.0`, and `ai@7.0.97` when using the model entry point.
The repository example uses `workspace:*`; it does not require an npm publication.

## Entry points

| Import | Exports |
| --- | --- |
| `cf-open-agents-api` | Wire schemas/types, `ApiError`, `remoteApiError`, runtime contracts, Effect boundary helpers |
| `cf-open-agents-api/cloudflare` | `createAgentService`, `AgentBindings`, `AgentRPC`, `AgentServiceClasses`, DO/Container classes and drivers |
| `cf-open-agents-api/models` | `aiSDKModel`, `nativeModel`, `openAICompatibleModel`, `createModelGateway` |
| `cf-open-agents-api/tools` | Function tool contracts, search presets, immutable asset/skill helpers |

See [the composition root](../examples/worker/src/index.ts) for a complete deployment.
`createAgentService(options)` returns `AgentWorker` and `SessionDO` classes configured together.
Subclass/export both, and bind the tenant catalog, harness, Sandbox, and R2 resources in Wrangler.

| Factory option | Purpose |
| --- | --- |
| `agents` | Public model aliases mapped to `{ harness, model, delegates? }` |
| `harnesses(env)` | Execution drivers, usually `containerHarnesses` |
| `authenticate(request, env)` | Resolve an HTTP request to a tenant ID or `null` |
| `objects(env)` | R2 bucket used for configuration and artifact content |
| `environments(env)` | Hosted environment driver, usually `containerEnvironments` |
| `maxTurnMs` | Turn deadline; default 15 minutes |
| `pollIntervalMs` | Durable reconciliation interval; default one second |

`openai_hosted` is the upstream wire name for this deployment's Cloudflare Sandbox.
Provider keys belong in `createModelGateway`'s Worker, not in client configuration or native runtime snapshots.
[Extending the service](extending.md) describes model capabilities, custom drivers and tools.

## Session RPC methods

Every method takes a trusted `tenant` first.
Types come from the package's exported schemas; `PageQuery` accepts `after`, `limit`, and `order`.

| Method | Result |
| --- | --- |
| `createSession(tenant, parameters, key?)` | `AgentSession` |
| `forkSession(tenant, id, parameters?, key?)` | `AgentSession`; `/cf/v1` extension, see [forks](environments-and-tools.md#fork-a-session) |
| `retrieveSession(tenant, id)` | `AgentSession` |
| `listSessions(tenant, query?)` | `ListPage<AgentSession>`; optional `agent_id` filter |
| `submitEvents(tenant, id, events, key?)` | `void` |
| `listItems(tenant, id, query?)` | `ListPage<AgentSessionItem>` |
| `listTurns(tenant, id, query?)` | `ListPage<Turn>` |
| `retrieveTurn(tenant, id, turnId)` | `Turn` |
| `deleteSession(tenant, id)` | `{ id, object: "agent.session.deleted", deleted: true }` |

All results are promises. Defaults and validation match the corresponding HTTP operations.
For streaming and other official resources, use `AGENTS.fetch` through the OpenAI client.
The package's root import has no Cloudflare runtime import, so types/schemas can also be consumed from Node.

## Effect extension contracts

`RuntimeDriver` and `EnvironmentDriver` methods return `Effect<A, ServiceError>`.
`containerEnvironments(env)` adapts the Container RPC boundary to that contract.
A custom environment driver implements `prepare`, `status`, `upload` and `files`;
`EnvironmentSpec` identifies the session and its private configuration object.
The environment listing uses the official SDK's `page`/`next` token contract.

`prepare` receives `inherited` when a fork adopts another session's committed
workspace; the Container driver copies the source's base backup and capability
roots after applying the network policy to the new sandbox.
Compose typed failures, interruption and resource release inside the driver.
Use `io` for SDK/HTTP/RPC promises and `attempt` for synchronous validation or storage.
Run the resulting Effect at a platform boundary with `runPromise`.
SQLite transaction callbacks remain synchronous and cannot return Effects.
The [Effect architecture](effect.md) describes lifecycle gates, finalizers and recovery.
