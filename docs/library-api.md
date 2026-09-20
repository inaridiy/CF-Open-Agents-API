# Library API

`cf-open-agents-api` implements the OpenAI Agents API with configurable native runtimes and model connections. Use the official SDK over a [Service Binding](service-binding.md) or [HTTP](http-api.md), or call the [typed RPC surface](rpc.md). Running any harness needs the Docker images in the repository's `docker/` directory; the library alone gives you the API and the drivers, not the runtimes.

## Install

The setup CLI, [`create-cf-open-agents-api`](../packages/create-cf-open-agents-api/README.md), adds the package, its peers (`effect@3.22.2`, `openai@7.15.0`, `ai@7.0.97`, `zod@4.6.2`), the provider package, the Wrangler bindings, the composition and the Docker image snapshot to a Workers project in one run: `pnpm dlx create-cf-open-agents-api@alpha init`. The workspace examples use `workspace:*`.

The packages are not on npm yet. Until then, build the tarballs from a checkout and pass them to the CLI (`--library`, `--cli-package`, `--source`), as its README describes:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm --filter cf-open-agents-api pack --pack-destination /tmp/cf-open-agents-package
```

`pnpm add /absolute/path/to/the.tgz` also works without the CLI, together with the peers above.

## Entry points

| Import                          | Exports                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cf-open-agents-api`            | Wire schemas and types, `parse` and `parseEffect`, the tagged error classes with `DomainError`, `DomainTag`, `Capability`, `isDomainError`, `toApiError`, `caughtFailure`, `projectApiError` and `isPermanent`, `ApiError` and `remoteApiError`, `HARNESSES`, runtime schemas, `RuntimeDriver`, `PromiseRuntimeDriver` and `fromPromiseDriver`, workspace tool contracts, `io`, `attempt`, `OperationError`, `decode`, `decodeEffect`, `runPromise`, `runSync` |
| `cf-open-agents-api/cloudflare` | `defineAgentWorker`, `AgentWorkerOptions`, `AgentWorkerClasses`, `createAgentService`, `AgentBindings`, `AgentRPC`, `AgentServiceClasses`, `bearerTenant`, `tenantFetch`, `CatalogObject`, `SessionObject`, `HarnessContainer`, `SandboxContainer`, `ContainerProxy`, `createHarness`, `containerHarnesses`, `codexDriver`, `claudeCodeDriver`, `openCodeDriver`, `containerDriver`, `containerEnvironments`, `EnvironmentDriver`, `EnvironmentSpec`           |
| `cf-open-agents-api/models`     | `nativeModel`, `aiSDKModel`, `openAICompatibleModel`, `modelAdapter`, `createModelGateway`, `ModelRegistration`, `sanitizeProviderError`, `fetchWithoutRedirect`                                                                                                                                                                                                                                                                                               |
| `cf-open-agents-api/tools`      | `defineTool`, `webSearch`, `knowledgeSearch`, `publishSkill`, `loadSkill`, `skillReader`, `installSkill`                                                                                                                                                                                                                                                                                                                                                       |

The root import has no Cloudflare runtime dependency, so its types and schemas can be used from Node. `cf-open-agents-api/cloudflare` composes the model gateway without loading the optional `ai` peer; only `cf-open-agents-api/models` needs it, for `aiSDKModel` and `openAICompatibleModel`.

## Composition

`defineAgentWorker(options)` composes the API Worker, the `SessionDO` and the private model gateway in one call and returns every class a deployment exports. [The example composition](../examples/worker/src/index.ts) is the whole file:

```ts
export const { Agents, Models, SessionDO, TenantCatalogDO, HarnessDO, SandboxDO, ContainerProxy } =
  defineAgentWorker<Bindings>({
    agents: { codex: { harness: "codex", model: "codex", webSearch: true } },
    models: (env) => ({
      codex: () =>
        nativeModel({
          protocol: "responses",
          baseURL: "https://api.openai.com/v1",
          apiKey: env.OPENAI_API_KEY,
          model: "gpt-6-astra",
        }),
    }),
    authenticate: (request, env) => bearerTenant(request, env.API_TOKEN, "default"),
  });
export default Agents;
```

Wrangler binds the Durable Objects by these export names and the model gateway by the `Models` entrypoint (`services: [{ binding: "MODEL_GATEWAY", service: "<this worker>", entrypoint: "Models" }]`). A Worker with its own default export re-exports the classes from a separate module and reaches the API through a second self binding, `AGENTS` → entrypoint `Agents`; the [setup CLI](../packages/create-cf-open-agents-api/README.md) writes both forms. `HarnessDO` is the `HarnessContainer` class itself: the Container SDK keys its outbound handler registry by class name, so never subclass it; pass a `createHarness(...)` class through the `harness` option instead.

| Option                       | Purpose                                                                                                                                                                                         |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agents`                     | Presets: public model names mapped to `{ harness, model, delegates?, tiers?, webSearch? }`; `tiers` names the gateway models a Claude Code subagent's `haiku`/`sonnet`/`opus` alias resolves to |
| `models(env)`                | The gateway registry: names the presets refer to, mapped to `nativeModel`, `aiSDKModel`, `openAICompatibleModel` or a factory built on first use                                                |
| `authenticate(request, env)` | Resolve an HTTP request to a tenant ID or `null`; `bearerTenant` is the single-tenant example                                                                                                   |
| `harnesses(env)`             | Runtime drivers by name; defaults to `containerHarnesses`. Supplying it makes the composition explicit: `environments` and `objects` then default to nothing                                    |
| `environments(env)`          | Hosted environment driver; defaults to `containerEnvironments`. Without it `openai_hosted` configuration is rejected                                                                            |
| `objects(env)`               | R2 bucket for environment configuration, input files, skills and artifacts; defaults to `env.CHECKPOINTS`                                                                                       |
| `harness`                    | A `createHarness(...)` class to export as `HarnessDO`                                                                                                                                           |
| `maxTurnMs`                  | Turn deadline; default 15 minutes                                                                                                                                                               |
| `pollIntervalMs`             | Reconciler alarm interval and the budget of one tick; default 5 seconds. The container drivers long-poll within it                                                                              |

The overloads decide what is required: with `ContainerBindings` in `Env` every driver has a default; without them `harnesses` is required. `createAgentService(options)` remains the lower-level factory: it returns `AgentWorker` and `SessionDO` configured together, and a composition that needs something else (its own gateway entrypoint, several services in one Worker) subclasses and exports those, `CatalogObject`, `HarnessContainer`, `SandboxContainer` and `ContainerProxy`, plus a `WorkerEntrypoint` that delegates to `createModelGateway(...).fetch`.

`openai_hosted` is the SDK's wire name for this deployment's Cloudflare sandbox. Provider keys belong in the gateway Worker, not in client configuration or native runtime snapshots. [Extending the service](extending.md) describes presets, model adapters, custom drivers and tools.

## Session RPC methods

Every method takes a trusted `tenant` first. Types come from the exported schemas; `PageQuery` accepts `after`, `limit` and `order`.

| Method                                       | Result                                                                                        |
| -------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `fetchAs(tenant, request)`                   | `Response`; serves one HTTP request of the Agents API as `tenant`, skipping the authenticator |
| `createSession(tenant, parameters, key?)`    | `AgentSession`                                                                                |
| `forkSession(tenant, id, parameters?, key?)` | `AgentSession`; `/cf/v1` extension, see [forks](environments-and-tools.md#fork-a-session)     |
| `retrieveSession(tenant, id)`                | `AgentSession`                                                                                |
| `listSessions(tenant, query?)`               | `ListPage<AgentSession>`; optional `agent_id` filter                                          |
| `submitEvents(tenant, id, events, key?)`     | `void`                                                                                        |
| `listItems(tenant, id, query?)`              | `ListPage<AgentSessionItem>`                                                                  |
| `listTurns(tenant, id, query?)`              | `ListPage<Turn>`                                                                              |
| `retrieveTurn(tenant, id, turnId)`           | `Turn`                                                                                        |
| `deleteSession(tenant, id)`                  | `{ id, object: "agent.session.deleted", deleted: true }`                                      |

All results are promises. Defaults and validation match the HTTP operations. Streaming and the other official resources go through the OpenAI client with `tenantFetch(agents, tenant)` as its `fetch`: it calls `fetchAs`, so the trusted Worker names the tenant and no bearer token crosses the binding. It exists because a `Request` passed to an RPC method is structured-cloned and cannot carry the SDK's `AbortSignal`; `tenantFetch` sends the request without the signal and rejects with an `AbortError` on the caller's side when the signal fires. `AGENTS.fetch` remains the path through the HTTP authenticator for a caller that only holds a token. See the [Service Binding guide](service-binding.md#connect-the-official-client).

## Effect extension contracts

`RuntimeDriver` and `EnvironmentDriver` methods return Effects. `ServiceError`, the error type of an `EnvironmentDriver` method, is `DomainError | OperationError | ApiError`: a tagged class from `errors.ts`, the `OperationError` that `io` and `attempt` produce for an untagged cause, or an `ApiError` recovered from an RPC wire name. `RuntimeDriver` methods are typed per method and must fail with the tagged classes the root import exports:

| Method                                     | Failures                                                  |
| ------------------------------------------ | --------------------------------------------------------- |
| `start(execution, operationId)`            | `RuntimeRejected`, `TransportFailure`                     |
| `poll(execution, after, options?)`         | `TransportFailure`                                        |
| `control(execution, operationId, command)` | `CommandRejected`, `ExecutionMissing`, `TransportFailure` |
| `checkpoint(execution)`                    | `RuntimeRejected`, `TransportFailure`                     |
| `stop(execution)`                          | `TransportFailure`                                        |

`TransportFailure` is the only retryable failure: no answer, or an answer nobody can classify. Every other tag is a definite answer the reconciler acts on at once and never retries. `poll` takes `{ waitMs }`; a driver that honors it returns at once with events after the cursor or a terminal outcome and otherwise after `waitMs`, and declares `longPoll: true` so the reconciler polls it for the rest of each alarm interval. A driver without the flag is polled once per alarm with `waitMs` zero.

`fromPromiseDriver` adapts a `PromiseRuntimeDriver`, whose methods receive the fiber's `AbortSignal` (`start(execution, operationId, signal)`, `poll(execution, after, signal, options)`, `control(execution, operationId, command, signal)`, `checkpoint(execution, signal)`, `stop(execution, signal)`) and may ignore it when the underlying call cannot be cancelled. A thrown `{ status, code }` answer (an `ApiError`, its RPC wire name, or a plain object) is a definite rejection: `404 execution_missing` and any other answer to `control` become `ExecutionMissing` and `CommandRejected`, an answer to `start` or `checkpoint` becomes `RuntimeRejected`; everything else is a `TransportFailure`. The adapter forwards `longPoll`.

`containerEnvironments(env)` adapts the Container RPC boundary to the `EnvironmentDriver` contract. A custom environment driver implements `prepare`, `status`, `upload` and `files`; `EnvironmentSpec` identifies the session and its private configuration object, and `prepare` receives `inherited` when a fork adopts another session's committed workspace. The environment listing uses the SDK's `page`/`next` token contract.

Use `io(name, (signal) => promise)` for SDK, HTTP and RPC calls; the callback always receives the fiber's interruption signal. Use `attempt(name, () => value)` for synchronous validation or storage, and `parseEffect(schema, input)` to keep a zod validation failure in the error channel as `InvalidRequest`. Run an Effect only at a platform boundary with `runPromise`; `runSync` is for effects that provably never suspend. SQLite transaction callbacks stay synchronous and cannot return Effects or Promises. Failures cross the HTTP boundary through `toApiError`; `isPermanent` names the conflicts the SDK must not retry. The [house rules](effect.md) apply.

The `RpcResult` type and the `rpcFailure` and `unwrap` helpers of earlier snapshots are gone: Durable Object RPC results travel in a `Schema.Either` envelope (`encodeRpc`, `decodeRpc`), which is internal to the package.
