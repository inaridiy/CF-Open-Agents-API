# Implementation record

The broad design is in [architecture.md](architecture.md). The public alpha profile
is in [compatibility.md](compatibility.md). No subagents were used to implement this
repository. No cloud resources were deployed and no paid model calls were made.

## Delivered structure

- A pnpm workspace with a public ESM/TypeScript library, a Node supervisor, and a
  deployable Worker example. Apache-2.0, contributor guide, and CI are included.
- HTTP and Service Binding entrypoints sharing tenant catalogs and SessionDO state.
  Inputs, required actions, turns, output items and replayable events are durable.
- Codex app-server in a harness Container and native exec-server in a separate
  Sandbox SDK Container. Model credentials remain in a private Worker binding.
- Kysely `0.29.5` for every SQLite query and schema. Its compile-only components
  feed a synchronous execution bridge so `transactionSync` can roll back complete
  state transitions. `kysely-durable-objects@0.2.2` was probed and rejected because
  its async transaction boundary and SqlStorage types do not fit this runtime.
- AI SDK 7 model factories, a concrete Workers AI provider example, bounded model
  steps, external functions, and R2 message checkpoints.
- Common typed tools, web/corpus search presets, immutable skill bundles, integrity
  checks, progressive skill reads and a fresh-workspace provisioning hook.

## Runtime findings captured in the implementation

1. Container outbound handlers must use the SDK's static setter and register the
   concrete class. TypeScript static fields bypass that setter.
2. WebSocket upgrades must cross the native `fetch` boundary. A custom DO RPC method
   cannot serialize a WebSocket response. The native exec-server route uses fetch.
3. R2 requires a known body length. Native snapshots from the Node supervisor are
   buffered within the snapshot limit before upload.
4. Native Codex SQLite records absolute rollout paths. CODEX_HOME stays fixed inside
   each Container, and restoration starts from a fresh directory at that location.
5. A dispatched job is not blindly replayed after Container loss. Operation IDs,
   generation fencing, alarm reconciliation and explicit unknown outcomes govern
   retries. Checkpoint references commit before a completed turn is published.
6. Input validation and outbox writes share a transaction. Common expected RPC
   validation failures use result envelopes, avoiding platform error logs.
7. SSE reads persisted pages under backpressure. Public item IDs are scoped to the
   turn even if a provider reuses its native IDs.

## Dependency and verification basis

Registry artifacts and actual exports were inspected on 2026-09-12. Versions are
pinned in the lockfile. Sandbox package/image versions match exactly. The Workers
Vitest pool requires Vitest 4.1; the runtime override aligns its workerd with Wrangler.

Verified locally on 2026-09-12: 14 workerd integration tests passed, the native Codex
protocol test passed (including external functions), and the two-Container smoke
passed with skill provisioning and destruction/restore. Typecheck, lint, declaration
builds, generated bindings, package assembly and the Worker deployment dry run passed.
The packed tarball was also installed in a separate temporary consumer project;
its Worker/Codex/AI SDK factory types compiled and its Node-compatible schema export
loaded successfully. The checked-in CI workflow repeats the main gates; hosted CI
has not yet run.

Acceptance commands:

- `pnpm check`: strict typecheck, Biome, real workerd/SQLite tests, declaration builds.
- `pnpm test:codex`: real Codex 0.154.0 app-server and separate exec-server processes,
  local scripted Responses, native shell and external function calls, history
  restoration after deleting the original home. The shell reads a marker available
  only in the exec-server environment.
- `pnpm test:containers`: real Worker and two Containers, native shell isolation,
  skill provisioning and R2 restore after destroying both Containers. A local
  scripted model supplies protocol responses; this is not model-quality evidence.
- `pnpm types`, `pnpm deploy:check`, and `pnpm --filter cf-open-agents-api pack`: binding
  generation, both Docker builds/Worker dry run, and package assembly.

The Container smoke runs in rootlesskit's actual network namespace on the initial
Linux development host. Reproduction is in [deployment.md](deployment.md). Upstream
local warnings are scoped in [known-issues.md](known-issues.md).

Claude Code/OpenCode adapters, upstream subagent and artifact APIs, cross-harness
forks, and managed knowledge indexing remain outside this alpha. The driver/tool
interfaces and design explain how to add them; unsupported wire fields are rejected.
