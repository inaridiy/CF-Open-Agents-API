# Contributing

Use Node 24+ and the pinned pnpm version. Run `pnpm install --frozen-lockfile`, then
`pnpm check`. Run `pnpm test:codex` when changing the supervisor or Codex protocol.
Container transport changes also require the Docker smoke described in deployment
notes. Clearly distinguish local scripted providers from real provider evidence.

## Code map

- `packages/agent-api/src/protocol.ts`: supported wire schemas and public types.
- `service.ts`, `catalog.ts`, `session.ts`: HTTP/RPC, tenant discovery, durable state.
- `storage.ts`: Kysely queries with a synchronous SQLite execution bridge.
- `runtime.ts`: the common execution driver contract.
- `containers.ts`: Container lifecycle, model egress, and workspace snapshots.
- `ai-sdk.ts`: optional AI SDK harness, model factory injected by the deployment.
- `tools.ts`: tool contracts, provider-neutral presets, and immutable assets.
- `packages/supervisor/src`: the Node process that owns Codex app-server.
- `examples/worker`: deployable composition; no test fixture enters this build.
- `tests/workers`: real workerd/SQLite integration with a scripted harness.
- `tests/codex`: real Codex app-server/exec-server with a scripted model endpoint.

## Changes worth discussing

Open an issue before changing public wire behavior, persistent record formats,
checkpoint formats, or minimum provider capabilities. Describe the trigger and
observable behavior. Small fixes and documentation improvements need no proposal.

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
