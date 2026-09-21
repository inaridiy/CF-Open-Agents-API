# Contributing

Use Node 24 and the pinned pnpm (`11.1.2`). Run `pnpm install --frozen-lockfile` from the repository root; the `prepare` hook patches TypeScript and oxlint for the Effect language service. Coding-agent entrypoints, the toolchain and the vendored skills are described in the [development harness guide](docs/development-harness.md); `.agents/` and `pnpm check:harness` exist for coding agents, and a human contributor can ignore them.

## Local development

The examples run against your Cloudflare account: Workers AI has no local emulator, so `wrangler dev` sends `AI` binding calls to the account you are logged into, and the `workers` preset counts against your Workers AI usage. Docker must be running; the first `wrangler dev` builds both images.

```sh
pnpm install --frozen-lockfile
pnpm bootstrap        # writes the worker, demo and caller .dev.vars with one random API_TOKEN
pnpm exec wrangler login
pnpm dev:caller       # builds the library first, then both images; caller on http://localhost:8788
```

`pnpm dev` runs the Agent Worker alone on `http://localhost:8787`; `pnpm dev:caller` runs the caller example together with it. Leave `OPENAI_API_KEY` empty in `.dev.vars` if you have no key: presets are built only when a session selects them, and the `workers` preset never calls OpenAI. Then, with the `API_TOKEN` from `examples/worker/.dev.vars`:

```sh
export AGENT_API_TOKEN=...
curl http://localhost:8788/sdk/sessions \
  -H "Authorization: Bearer $AGENT_API_TOKEN" \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: first-report' \
  -d '{"agent":{"model":"workers"},"environment":{"type":"openai_hosted"},"input":"Write /workspace/outputs/report.txt with a short greeting, then read it back and report the result."}'
```

Poll `GET /sdk/sessions/<id>` with the same header until `session.status` is `idle`, `requires_action` or `failed`; the response includes the items and turns. `DELETE /sdk/sessions/<id>` removes the session. The [caller source](examples/caller/src/index.ts) implements this journey through both the SDK (`/sdk`) and typed RPC (`/rpc`). Use `"model":"codex"` with a real `OPENAI_API_KEY` for the full Codex experience; `claude` and `opencode` run the other runtimes against the same key through the portable AI SDK adapter. On a rootless Docker engine, see [local runtime notes](docs/deployment.md#local-runtime-notes).

## Toolchain

| Command                   | Purpose                                                                                       |
| ------------------------- | --------------------------------------------------------------------------------------------- |
| `pnpm lint`               | Type-aware oxlint rules, the repository lint plugin and an oxfmt formatting check (ultracite) |
| `pnpm format`             | Apply safe lint fixes and format                                                              |
| `pnpm typecheck`          | TypeScript 7 with Effect diagnostics through `@effect/tsgo`                                   |
| `pnpm effect:diagnostics` | Effect language-service diagnostics alone                                                     |

Every lint finding is an error: the correctness subset, the promoted `no-shadow` and `no-unsafe-*` families, and the `complexity` and `no-nested-ternary` quality rules apply to packages, tests and examples alike. The repository plugin in `scripts/lint/agent-api-plugin.mjs` enforces the parts of the [Effect house rules](docs/effect.md#the-five-house-rules) the type checker cannot see: `agent-api/no-run-in-transaction` everywhere, and for the Worker package `agent-api/no-run-below-entrypoint` (a runner is allowed only in the allow-listed entrypoint files and only on a line preceded by `// lint: entrypoint`) and `agent-api/no-api-error-construction`. `pnpm test:scripts` runs the plugin's rule tests.

Format only the files you change: `pnpm exec oxfmt <files>`. Markdown is formatted too, with prose wrapping preserved. Do not reformat unrelated files in a change.

## Validation

Run commands from the repository root. Pick the rows that match the change; CI runs the whole matrix. Scripted suites use local fixtures and need no production credentials. State clearly which evidence came from scripted inference and which from a real provider.

| Change                                                             | Checks and completion evidence                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Prose, agent instructions, skill inventory                         | `pnpm check:docs`, `pnpm check:harness`, `pnpm exec oxfmt --check <files>`; read the diff                                                                                                                                                                                                                                                                                                                          |
| Development checker scripts                                        | The two checks above plus `pnpm test:scripts` and `pnpm lint`                                                                                                                                                                                                                                                                                                                                                      |
| API, session, storage logic, runtime dependencies or test behavior | `pnpm check`; a correctness fix needs a behavioral regression test at the affected boundary                                                                                                                                                                                                                                                                                                                        |
| Supervisor, model gateway, native protocols or checkpoint formats  | `pnpm check`, `pnpm test:codex`, `pnpm test:harnesses`; exercise the affected runtime and history recovery                                                                                                                                                                                                                                                                                                         |
| Container transport, sandbox tools, R2 restore or Docker images    | The applicable rows above plus `pnpm test:containers`; see [local runtime notes](docs/deployment.md#local-runtime-notes)                                                                                                                                                                                                                                                                                           |
| Public package exports, dependencies or release assembly           | `pnpm check`, `pnpm test:package`; native and container checks when their dependency tree changes                                                                                                                                                                                                                                                                                                                  |
| Worker bindings, configuration or deployment packaging             | `pnpm types`, `pnpm build`, `pnpm deploy:check`; transport changes also need the container smoke                                                                                                                                                                                                                                                                                                                   |
| The setup CLI, its templates or the generated project files        | `pnpm build`, `pnpm test:cli`, `pnpm lint`, `pnpm test:package`; a composition-renderer change also needs `pnpm check:docs` and `examples/worker/src/index.ts` and `examples/demo/src/agents.ts` regenerated by hand (`pnpm test:cli` compares them byte for byte); the demo app's `src/index.tsx`, `src/ui.tsx` and `README.md` need no such step, since the CLI package's build copies them from `examples/demo` |

What each suite covers:

- `pnpm test` (`tests/workers`): the production composition in workerd with SQLite Durable Objects and a scripted runtime driver. API and wire shapes, Service Binding RPC, session liveness (alarm re-arm, command delivery, fail-fast), cancellation and retry, recovery after lost responses, forks, environments, skills, programmatic tools, assets, the error projection of every tag, the repository seam and the reconciler's policy on the in-memory store, streaming and the Effect boundaries. `tests/workers/state-contracts.ts` holds the compile-time contracts (synchronous transactions, fenced transitions).
- `pnpm test:codex` (`tests/codex`): real Codex app-server and exec-server with a scripted Responses endpoint. Turn error mapping, user-input requests, native subagents, compatibility of the Codex protocol.
- `pnpm test:harnesses` (`tests/harnesses`): all three native runtimes through the supervisor with scripted models, the model gateway through the official OpenAI and Anthropic clients, MCP, media and usage, delegation, workspace tools, supervisor lifecycle and concurrency, history restored after the original home is removed. Needs Codex `0.154.0` on `PATH`.
- `pnpm test:containers` (`scripts/test-containers.mjs`, `tests/containers`): the real Worker, Container and R2 path in Wrangler's local emulation with Docker. Needs Docker and `python3`; see [deployment](docs/deployment.md#local-runtime-notes) for the rootless recipe.
- `pnpm test:package`: packs the library and typechecks a consumer against the tarball.
- `pnpm test:scripts`: unit tests of the checker, bootstrap and container scripts. The label test imports the built library, so run `pnpm build` first.
- `pnpm test:cli` (`packages/create-cf-open-agents-api/test`, vitest in Node): `init` against fixture projects (retrofit, standalone, idempotency, dry run, conflicts, `--force`), the snapshot, `doctor`, `setup` through a fake runner, the pins against the workspace manifests, and every rendered composition formatted with oxfmt and typechecked against the built library. Run `pnpm build` first; the standalone tests compare the output with `examples/worker` (minimal template) and `examples/demo` (demo template) byte for byte.

Match recurring diagnostics against [known issues](docs/known-issues.md). See [scope and completion](#scope-and-completion) for boundaries.

## Code map

- `packages/agent-api/src/protocol.ts`: wire schemas, public types, `parse` and `parseEffect`, limits such as the image cap; `bytes.ts`: `sha256Hex` and `readBounded`, shared by the Worker, the container routes and the model gateway, with no imports of its own.
- `errors.ts`: the layered error vocabulary — most failures are rows of the `DEFINITE` table (tag, status, code, message); about 21 classes are written by hand for envelope, retryable or dynamic-answer needs — `toApiError` (the only status and code table), `isPermanent`, the RPC envelope; `api-error.ts`: the `ApiError` projection; `effect.ts`: `io`, `attempt`, `OperationError`, the boundary runners.
- `service.ts`: the composition root, the `AgentWorker` RPC methods, `tenantFetch` and `bearerTenant`; `service-validation.ts`: request validation against the presets; `session-reservation.ts`: the session record creation and fork share; `http/app.ts`: the Hono app and its error handler; `http/`: one route module per resource (sessions, agents, environments, files, skills, vaults, capabilities).
- `session.ts`: `SessionObject`, its runtime, the synchronous RPC reads and the SSE stream; `session-services.ts`: the `Drivers`, `Alarm` and `Repo` services; `session-state.ts`: the synchronous state machine; `session-reconcile.ts`: the reconciler tick; `session-events.ts`: projection of runtime events into public items and events.
- `persistence/`: the repository seam (`Kind`, `RecordStore`, `MemoryStore`, `Repo`, `SessionTx` and `SessionRepo`, `HarnessTx`, `Fenced`); `storage.ts`: `SqlStore`, Kysely queries executed synchronously in SQLite, row and page budgets.
- `catalog.ts`: the tenant catalog; `runtime.ts`: Effect schemas, the `RuntimeDriver` contract and `fromPromiseDriver`.
- `containers.ts`: HarnessDO and SandboxDO and the container drivers; `containers/`: `host.ts` (bindings and services), `assignment.ts` (the execution authority and `modelAllowed`), `sandbox.ts` (sandbox reuse), `proxies.ts` (model, MCP and media egress), `delegation.ts` (delegated children), `checkpoint.ts` (checkpoints and artifacts), `diagnostics.ts` (the harness diagnostics hint).
- `container-environments.ts`, `environment-config.ts`, `environments.ts`: hosted environment setup, uploads, inheritance.
- `skills.ts`, `skill-zip.ts`, `capability-archive.ts`, `files.ts`, `vaults.ts`: tenant-owned skills, input files and credentials.
- `programmatic.ts`, `programmatic-contract.ts`: isolated code execution and its tool bridge.
- `models.ts`, `models/`: model adapters, protocol translation, error sanitizing.
- `workspace.ts`, `sandbox-tools.ts`, `portable-capabilities.ts`: workspace tool contracts, sandbox execution, skill and plugin discovery.
- `tools.ts`: tool contracts, search presets and immutable asset helpers.
- `packages/supervisor/src`: `server.ts` (the container HTTP API and its one status table), `main.ts`, `job.ts` (the `Job` lifecycle, finalizer-ordered stop), `lifecycle.ts` (`JobLog`, `Operations`, `once`, the tagged failures, `statusToTurnCode`), `events.ts` (id generation and the shared event constructors), `process.ts` (process acquisition, readiness and termination), `json-rpc.ts` (the Codex app-server transport), `codex.ts`, `claude-code.ts`, `opencode.ts` (adapters), `delegation.ts` (cross-runtime children), `remote-tools.ts` (MCP bridge), `checkpoint.ts`.
- `scripts/lint/agent-api-plugin.mjs`: the repository lint rules and their tests.
- `worker.ts`: `defineAgentWorker`, the one-call composition; `models/gateway.ts`: the model gateway, `nativeModel` and the error sanitizer, kept free of the optional `ai` peer.
- `packages/create-cf-open-agents-api/src`: the setup CLI. `init.ts` computes every change against a `Files` overlay and writes once at the end, so a step it refuses leaves the project exactly as it was; `steps/wrangler.ts` upserts the bindings with `jsonc-parser` edits and its conflict rules; `steps/vendor.ts` snapshots the Docker build context; `wrangler-cli.ts` runs the project's own wrangler, or prints the command for a dry run; `templates/agents.ts` renders the composition; `templates/files.ts` reads the demo app and rootless scripts shipped verbatim under `templates/`; `doctor.ts` and `setup.ts` back the other commands; `versions.ts` holds the pins a generated project receives.
- `examples/worker`: deployable composition and the CLI's standalone template; no test fixture enters this build. `examples/caller`: a consuming Worker.
- `docker/`: the harness and sandbox images.

## Changes worth discussing

For a proposed public wire, persistent record, checkpoint format or minimum-provider change, describe the trigger, observable behavior and the compatibility and recovery plan before implementation. An explicit request approving that change is the decision; no further approval round is needed. Small fixes and documentation improvements need no proposal.

Keep validation at boundaries. Never put model or provider credentials in a sandbox, serialize an AI SDK model instance, or retry a write whose outcome is unknown. Queries belong in typed repositories: declare a `Kind` for every record and go through a `SessionTx` or `HarnessTx`. Durable Object transactions stay synchronous: a transition is a plain function of the transaction view, compiled Kysely queries execute inside `transactionSync`, and a transition after I/O takes a `Fenced` record; do not replace that with an async `BEGIN`/`COMMIT` or hold a concurrency permit across network I/O. A new definite failure is usually one row of the `DEFINITE` table in `errors.ts` (tag, status, code, message); write a class by hand only when it crosses Durable Object RPC as envelope data, is retryable, or its runtime answer carries its own status, code or message. Never `new ApiError(...)`. Follow the [Effect house rules](docs/effect.md).

Add a behavioral regression test for a correctness fix. Use the smallest useful layer, but use real workerd for SQLite, RPC and alarm changes and real Codex for protocol changes. Tests must not read a developer's OpenAI or Codex credentials.

Update the compatibility profile and README when an endpoint, field, script or setup step changes; a change to the composition in `examples/worker` is a change to the CLI's template and vice versa. Generated `dist/` and binding types are not checked in. New persistent schemas need an explicit version migration and restart evidence.

Pull requests state what failed before, the resulting behavior and the checks run. Keep commits focused. A change that alters what a release ships adds a changeset (`pnpm changeset`: pick any of the three packages, since they share one version, and write the summary for the changelog); documentation and test changes need none. `pnpm release` is what the publish workflow runs after a "Version packages" pull request merges; see [releasing](docs/releasing.md).

## Dependencies

Renovate proposes updates weekly and only for releases at least 24 hours old (`minimumReleaseAge: "1 day"` in `renovate.json`); the native runtime and Sandbox pins are excluded and bumped by hand. A new dependency needs a reason beyond saving a few lines, verified exports, compatible peers and an updated lockfile. The setup CLI's three runtime dependencies are `gunshi` (typed subcommands, flags and help), `@clack/prompts` (terminal prompts and spinners) and `jsonc-parser` (comment-preserving edits of `wrangler.jsonc`); the versions it writes into generated projects live in `packages/create-cf-open-agents-api/src/versions.ts` and must move with the workspace pins (`pnpm test:cli` compares them). To bump a fresh release yourself, `pnpm update <package>@<version>`, run the rows its consumers need, and note in the pull request that the release is younger than the policy and why it is needed now. A native runtime bump also updates `docker/`, `packages/agent-api/src/harnesses.ts`, the compatibility profile and the checkpoint revision; `pnpm check:docs` verifies that they agree.

## Scope and completion

Keep changes focused on the requested behavior and preserve unrelated work. Explain material public API or persistence changes and their recovery behavior. Run the validation rows the change needs, distinguish scripted integration from real-provider evidence, and report checks that could not run. Publishing, deployment and paid-provider calls are separate maintainer operations.

See [releasing](docs/releasing.md) for tags, CI and npm publication, and [SECURITY.md](SECURITY.md) for vulnerability reports.
