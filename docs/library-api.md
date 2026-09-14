# Library API

`cf-open-agents-api` implements the OpenAI Agents API with configurable native runtimes and model connections. Use the official SDK over a [Service Binding](service-binding.md) or [HTTP](http-api.md), or call the [typed RPC surface](rpc.md). Running any harness needs the Docker images in the repository's `docker/` directory; the library alone gives you the API and the drivers, not the runtimes.

## Install from source

The package is not on npm yet. Use the workspace examples, or build a local tarball:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm --filter cf-open-agents-api pack --pack-destination /tmp/cf-open-agents-package
```

Install the tarball in your project with `pnpm add /absolute/path/to/the.tgz`, together with the peers `effect@3.22.2`, `openai@7.15.0` and, for the model entrypoint, `ai@7.0.97`. The repository example uses `workspace:*`.

## Entry points

| Import                          | Exports                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cf-open-agents-api`            | Wire schemas and types, `ApiError`, `remoteApiError`, `parse`, `HARNESSES`, runtime schemas and `RuntimeDriver`, `fromPromiseDriver`, workspace tool contracts, `io`, `attempt`, `decode`, `decodeEffect`, `runPromise`, `runSync`                                                                                                                                   |
| `cf-open-agents-api/cloudflare` | `createAgentService`, `AgentBindings`, `AgentRPC`, `AgentServiceClasses`, `bearerTenant`, `CatalogObject`, `SessionObject`, `HarnessContainer`, `SandboxContainer`, `ContainerProxy`, `createHarness`, `containerHarnesses`, `codexDriver`, `claudeCodeDriver`, `openCodeDriver`, `containerDriver`, `containerEnvironments`, `EnvironmentDriver`, `EnvironmentSpec` |
| `cf-open-agents-api/models`     | `nativeModel`, `aiSDKModel`, `openAICompatibleModel`, `modelAdapter`, `createModelGateway`, `sanitizeProviderError`, `fetchWithoutRedirect`                                                                                                                                                                                                                          |
| `cf-open-agents-api/tools`      | `defineTool`, `webSearch`, `knowledgeSearch`, `publishSkill`, `loadSkill`, `skillReader`, `installSkill`                                                                                                                                                                                                                                                             |

The root import has no Cloudflare runtime dependency, so its types and schemas can be used from Node.

## Composition

See [the example composition](../examples/worker/src/index.ts). `createAgentService(options)` returns `AgentWorker` and `SessionDO` classes configured together. Subclass and export both, export `CatalogObject`, `HarnessContainer`, `SandboxContainer` and `ContainerProxy` under the class names your Wrangler configuration binds, and export a `WorkerEntrypoint` that delegates to `createModelGateway(...).fetch`.

| Factory option               | Purpose                                                                                                          |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `agents`                     | Presets: public model names mapped to `{ harness, model, delegates?, webSearch? }`                               |
| `harnesses(env)`             | Runtime drivers by name, usually `containerHarnesses`                                                            |
| `authenticate(request, env)` | Resolve an HTTP request to a tenant ID or `null`; `bearerTenant` is the single-tenant example                    |
| `objects(env)`               | R2 bucket for environment configuration, input files, skills and artifacts (the example's `CHECKPOINTS`)         |
| `environments(env)`          | Hosted environment driver, usually `containerEnvironments`; without it `openai_hosted` configuration is rejected |
| `maxTurnMs`                  | Turn deadline; default 15 minutes                                                                                |
| `pollIntervalMs`             | Reconciler alarm interval; default one second                                                                    |

`openai_hosted` is the SDK's wire name for this deployment's Cloudflare sandbox. Provider keys belong in the gateway Worker, not in client configuration or native runtime snapshots. [Extending the service](extending.md) describes presets, model adapters, custom drivers and tools.

## Session RPC methods

Every method takes a trusted `tenant` first. Types come from the exported schemas; `PageQuery` accepts `after`, `limit` and `order`.

| Method                                       | Result                                                                                    |
| -------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `createSession(tenant, parameters, key?)`    | `AgentSession`                                                                            |
| `forkSession(tenant, id, parameters?, key?)` | `AgentSession`; `/cf/v1` extension, see [forks](environments-and-tools.md#fork-a-session) |
| `retrieveSession(tenant, id)`                | `AgentSession`                                                                            |
| `listSessions(tenant, query?)`               | `ListPage<AgentSession>`; optional `agent_id` filter                                      |
| `submitEvents(tenant, id, events, key?)`     | `void`                                                                                    |
| `listItems(tenant, id, query?)`              | `ListPage<AgentSessionItem>`                                                              |
| `listTurns(tenant, id, query?)`              | `ListPage<Turn>`                                                                          |
| `retrieveTurn(tenant, id, turnId)`           | `Turn`                                                                                    |
| `deleteSession(tenant, id)`                  | `{ id, object: "agent.session.deleted", deleted: true }`                                  |

All results are promises. Defaults and validation match the HTTP operations. Streaming and the other official resources go through `AGENTS.fetch` with the OpenAI client.

## Effect extension contracts

`RuntimeDriver` and `EnvironmentDriver` methods return `Effect<A, ServiceError>`, where `ServiceError` is `ApiError | OperationError`. `containerEnvironments(env)` adapts the Container RPC boundary to that contract. A custom environment driver implements `prepare`, `status`, `upload` and `files`; `EnvironmentSpec` identifies the session and its private configuration object, and `prepare` receives `inherited` when a fork adopts another session's committed workspace. The environment listing uses the SDK's `page`/`next` token contract.

Use `io(name, (signal) => promise)` for SDK, HTTP and RPC calls and `attempt(name, () => value)` for synchronous validation or storage. Run an Effect only at a platform boundary with `runPromise`. SQLite transaction callbacks stay synchronous and cannot return Effects. The [house rules](effect.md) apply.
