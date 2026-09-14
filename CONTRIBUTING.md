# Contributing

Use Node 24+ and the pinned pnpm version. Run `pnpm install --frozen-lockfile`.
Agent entrypoints and selected Skills are described in the
[development harness guide](docs/development-harness.md).

## Validation

Run commands from the repository root. Select the rows affected by the change;
the CI workflow runs the full matrix for integration. Scripted suites use local
fixtures without production credentials. Clearly distinguish scripted inference
from real-provider evidence.

| Change | Checks and completion evidence |
| --- | --- |
| Prose, agent instructions, skill inventory | `pnpm check:docs` and `pnpm check:harness`; inspect the diff. |
| Development checker scripts | The documentation/harness checks, `pnpm test:scripts`, and `pnpm lint` |
| API/session/storage logic, runtime dependencies or test behavior | `pnpm check`; correctness fixes need a behavioral regression at the affected boundary |
| Supervisor, model gateway, native protocols or checkpoint formats | `pnpm check`, `pnpm test:codex`, `pnpm test:harnesses`; exercise the affected native runtime and history recovery |
| Container transport, Sandbox tools, R2 restore or Docker images | The applicable code/native checks plus `pnpm test:containers`; see [deployment prerequisites](docs/deployment.md) |
| Public package exports, dependencies or release assembly | `pnpm check`, `pnpm test:package`; native and Container checks when their dependency tree changes |
| Worker bindings/configuration or deployment packaging | `pnpm types`, `pnpm build`, `pnpm deploy:check`; transport changes also require Container smoke |

Match recurring diagnostics against [known issues](docs/known-issues.md). See [scope and completion](#scope-and-completion) for contribution boundaries.

## Code map

- `packages/agent-api/src/protocol.ts`: supported wire schemas and public types.
- `service.ts`, `catalog.ts`, `session.ts`: HTTP/RPC, tenant discovery, durable state.
- `storage.ts`: Kysely queries with a synchronous SQLite execution bridge.
- `runtime.ts`: Effect schemas and the common Effect execution driver contract.
- `effect.ts`: typed I/O failures, decoding and platform boundary runners.
- `docs/effect.md`: Effect state, concurrency and extension migration contracts.
- `containers.ts`: Container lifecycle, model egress, delegated children and workspace snapshots.
- `container-environments.ts`, `environment-config.ts`: hosted environment setup, uploads, inheritance.
- `skills.ts`, `skill-zip.ts`, `files.ts`, `vaults.ts`: tenant-owned skills, input files and credentials.
- `programmatic.ts`, `programmatic-contract.ts`: isolated code execution and its tool bridge.
- `models.ts`, `models/`: single-inference model adapters and bounded wire translation.
- `workspace.ts`, `sandbox-tools.ts`: shared remote tool contracts and Sandbox SDK execution.
- `tools.ts`: tool contracts, provider-neutral presets, and immutable assets.
- `packages/supervisor/src`: native Codex, Claude Code and OpenCode lifecycle adapters;
  `delegation.ts` relays cross-runtime children, `remote-tools.ts` bridges MCP servers.
- `examples/worker`: deployable composition; no test fixture enters this build.
- `tests/workers`: real workerd/SQLite integration with a scripted harness.
- `tests/codex`: real Codex app-server/exec-server with a scripted model endpoint.
- `tests/harnesses`: real native runtimes and official SDK clients through the model gateway.
- `tests/containers`: production Worker/Container/R2 paths with scripted inference.

## Changes worth discussing

For a proposed public wire, persistent record, checkpoint-format or minimum-provider
change, describe the trigger, observable behavior and compatibility/recovery plan
before implementation. An explicit request approving that change supplies the
decision; do not require another issue or approval round. If a material contract
choice is unresolved, clarify that choice while continuing independent work.
Small fixes and documentation improvements need no proposal. Post an issue only
when the user has authorized that external action.

Keep validation at boundaries. Do not put model/provider credentials in a sandbox,
serialize an AI SDK model instance, or retry a write whose outcome is unknown.
Queries belong in typed repositories. DO transactions must remain synchronous:
compile Kysely queries and execute them inside `transactionSync`; do not replace
that with an async BEGIN/COMMIT sequence or hold a concurrency block over network I/O.

Add a behavioral regression test for a correctness fix. Use the smallest useful
layer, but use real workerd for SQLite/RPC/alarm changes and real Codex for protocol
changes. Tests must not read a developer's OpenAI or Codex credentials.

Update the compatibility matrix and README when an endpoint, field, script, or
setup step changes. Generated `dist/` and binding types are not checked in.
New persistent schemas need an explicit version migration and restart evidence.

Pull requests should state what failed before, the resulting behavior, and the
checks run. Keep commits focused. New dependencies need a reason beyond saving a
few lines, verified exports, compatible peers, and an updated lockfile.

## Scope and completion

Keep changes focused on the requested behavior and preserve unrelated work.
Explain material public API or persistence changes and their recovery behavior.
Run the validation rows affected by a change, distinguish scripted integration
from real-provider evidence, and report checks that could not run. Publishing,
deployment, and paid-provider calls are separate maintainer operations.

See [release instructions](docs/releasing.md) for tags, CI, and npm publication.
Report vulnerabilities using [SECURITY.md](SECURITY.md).
