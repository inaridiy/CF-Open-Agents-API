# Changelog

## 0.2.0 (unreleased)

Nothing has been published to npm. The `v0.1.0` tag exists as history; this is the first version intended for public adopters.

### Fixed

- Session liveness: the alarm is re-armed before the reconciler permit check so a busy reconciler cannot consume the only wake-up; queued commands no longer block polling (a refused steer becomes the next turn, a refused tool result is dropped, a transient delivery failure is retried after the poll); the reconciler fails fast on runtime protocol violations, unregistered executors, revision mismatches and typed start rejections instead of polling until the deadline.
- Session lifecycle: a failed turn returns the session to `idle` with `session.error` set; only an indeterminate outcome (`outcome_unknown`, `programmatic_execution_uncertain`, other `*_uncertain` codes) leaves it `failed`. Deleted sessions purge their SQLite storage and catalog reservation and leave a tombstone; listing sessions tolerates a session deleted between the catalog page and retrieval.
- Streaming: each event is delivered once despite re-entrant `pull`; a creation stream ends after the initial turn settles (or right after `agent.session.created` without input); SSE keepalive comments every 15 seconds; the Hono router is built once per isolate and authenticates before buffering a body.
- Supervisor: event-log overflow fails the job with `native_output_limit` and stops the runtime instead of escaping a delegated relay as an unhandled rejection; stray rejections and exceptions are logged rather than taking the transport down; a broken stdin pipe or a malformed app-server line no longer fails in-flight requests.
- Cancel ordering: a requested cancel lets child terminal events through before the log is sealed, and a task or root that settles meanwhile reads as `cancelled`, never `completed`; cancelled Claude Code turns still report usage.
- Usage races: OpenCode usage and the settlement check read the event feed behind a session-metadata barrier; the Codex child-turn projection waits instead of assuming event order; control results resolve image parts before the memoized operation so a transient media failure stays retryable.
- Skill installation streams pinned bundles from R2 into the sandbox one at a time; malformed skills or plugins are skipped with a diagnostic instead of failing every turn start; plugin-derived MCP labels are sanitized and never replace configured servers.
- The portable AI SDK adapter never follows redirects; provider error bodies are sanitized and bounded before they reach the harness.
- A definite OAuth refresh rejection releases its reservation and marks the credential `credential_refresh_rejected` (rotate to recover); only a lost response stays `outcome_unknown`.
- A Codex steer the app-server rejects is `command_rejected`, so the Worker re-queues the message instead of retrying until `request_timeout`.
- OpenCode workspace tools accept streamed command results; a forked sandbox receives its network policy before it starts.

### Added

- `create-cf-open-agents-api`, the setup CLI: `init` adds the API to an existing Workers project (bindings upserted into `wrangler.jsonc` with comments kept, a generated `defineAgentWorker` composition, one re-export in the entry, a `.cf-open-agents-api/` snapshot the Dockerfiles build from, `.dev.vars` with a random token, pinned dependencies) or creates a new Worker that is `examples/worker`, generated; `setup` creates the R2 buckets and puts the production secrets in one `wrangler secret bulk`; `doctor` checks the toolchain and the binding agreement rules; `vendor` refreshes the snapshot from the `postinstall` hook.
- `defineAgentWorker` in `cf-open-agents-api/cloudflare` composes the API Worker, the `SessionDO` and the `Models` gateway entrypoint in one call and returns every class a deployment exports; the model gateway moved to `models/gateway.ts` so the Cloudflare entrypoint never loads the optional `ai` peer.
- `bearerTenant` logs once when `API_TOKEN` is missing or shorter than 32 characters instead of rejecting every request silently; `pnpm bootstrap` writes both example `.dev.vars` files with one token; `pnpm dev` builds the library first.
- Steering on every harness: Codex `turn/steer`, Claude Code's open prompt iterable with priority messages, OpenCode's `noReply` prompt with a rerun before settlement. A steer the runtime refuses is re-queued as the next turn.
- Native subagents on every harness: Codex threads, Claude Code `Options.agents` with the `Task` tool, OpenCode `task` children, projected as session subagents with scoped items, turns, usage and function calls.
- Agent settings applied natively: reasoning effort (Claude Code `Options.effort`, OpenCode provider variants), reasoning summary display, `text.format` `json_schema` structured output (Codex `outputSchema`, Claude Code `outputFormat`, OpenCode `StructuredOutput`), hosted web search on Claude Code (Anthropic `WebSearch`, `allowed_domains` enforced). `text.verbosity` and `service_tier` apply to Codex.
- `AgentRegistration.webSearch` declares that a preset's model connection provides hosted search; `web_search` tools need both a capable harness and such a preset.
- Portable gateway: `aiSDKModel` and `openAICompatibleModel` forward reasoning effort (`max` rounds to `xhigh`) and `json_schema` structured output on all three protocols; `aiSDKModel(model, { providerOptions: (settings) => ... })` maps decoded settings to provider options; `openAICompatibleModel({ supportsStructuredOutputs })` chooses `json_schema` or `json_object`.
- Codex turn failures carry the SDK's `SessionTurnError` codes derived from the app-server error, its upstream HTTP status or its message; `item/tool/requestUserInput` requests are projected as commentary and declined; `CodexOptions.codexConfig` adds `[features]` flags and provider keys.
- Wire: `x-request-id` on every response; `x-should-retry: false` on permanent 409s; tool names and MCP `server_label` use `[A-Za-z0-9_-]{1,64}`; the Files API accepts every `openai@7.15.0` purpose and filters listings by it; at most 256 distinct remote images per request (`413 image_limit`); `vault_ids: null`; empty bodies mean `{}` and a fork needs no body; `last_active_at` moves on accepted input and turn settlement; `agent.session.environment.disconnected` and `connected` are emitted from environment retrieval; `sessions.create({ stream: true })` returns an SSE stream.
- Sandbox reuse: the sandbox is kept between turns while it holds the last committed workspace; destroy, restore and reconfigure happen only after a cancel, a failure, a container loss or a fork. Assignment, child and checkpoint records moved from KV to SQLite rows so large configurations fit.
- Supervisor control contract: `409 command_rejected` for a command that can never apply, `404 execution_missing` for an unknown job, idempotent `204` for cancel; native failure detail goes to diagnostics behind stable public codes.
- Governance: `CODE_OF_CONDUCT.md`, `.github/CODEOWNERS`, `renovate.json` with a 24-hour release age, CI concurrency groups.

### Changed

- Effect architecture, described in [docs/effect.md](docs/effect.md):
  - Typed errors: failures are tagged classes in four layers (persistence, domain, runtime adapters, wire) in `errors.ts`; `toApiError` is the only table that maps a tag to a status and code, `isPermanent` decides `x-should-retry`, and `ApiError` is only the HTTP projection and its reconstruction from an RPC wire name. `io` always threads the fiber's `AbortSignal`; the writes a durable record depends on (the dispatch marker with `POST /jobs`, R2 checkpoint, artifact, file and upload puts, the catalog commit, the OAuth refresh commit) are `Effect.uninterruptible`.
  - RPC envelope: Durable Object RPC results travel in a `Schema.Either` envelope (`encodeRpc`, `decodeRpc`), so an expected failure re-enters the caller's fiber as a tagged instance instead of a platform exception.
  - Repository seam: SQLite sits behind `persistence/` (`Kind<A>`, `RecordStore`, `SessionTx`, `SessionRepo`, `HarnessTx`) with unchanged SQL; a transition after I/O takes a `Fenced<ActiveSession>` that only `tx.fenced` certifies, so a stale write does not compile.
  - Runtime: each session object runs a `ManagedRuntime` with `Drivers`, `Alarm` and `Repo`, and each HarnessDO one with `HarnessRepo` and `HarnessBindings`; the reconciler is one `Effect.fn` program with a `catchTags` policy and budgeted rounds; `Effect.run*` is confined to entrypoints.
  - SSE: one Effect `Stream` per listener over SQLite pages, woken by a sliding `PubSub` after each commit, merged with a scheduled keepalive, capped by a 64-permit semaphore, owned by the response's `ReadableStream`.
  - Long-poll: the reconciler polls the harness for the rest of its alarm interval (`RuntimeDriver.poll(execution, after, { waitMs })`, the `longPoll` flag, supervisor `GET /jobs/:turn?after=&wait=` up to 25 s per wait), so streaming latency follows the runtime; `pollIntervalMs` defaults to 5 seconds instead of one.
  - Supervisor scopes: each job is owned by an Effect `Scope`; processes are acquired into it (`SIGTERM`, grace period, `SIGKILL`), delegation relays and MCP clients are scoped fibers and resources, the stop sequence is the finalizer registration order, `JobLog.poll` waits for the next event, and `server.ts` maps every tagged failure to a status in one table.
- Public surface: the root import exports the error classes with `DomainError`, `DomainTag`, `Capability`, `isDomainError`, `toApiError`, `caughtFailure`, `projectApiError`, `isPermanent` and `parseEffect`; `ServiceError` is `DomainError | OperationError | ApiError`; `RuntimeDriver` methods are typed per method and a custom driver must fail with `RuntimeRejected`, `CommandRejected`, `ExecutionMissing` or `TransportFailure`; `PromiseRuntimeDriver` methods receive an `AbortSignal` and `poll` receives `PollOptions`; `createModelGateway` registry entries may be factories (`ModelRegistration`) built only when selected. The example Worker bundle grew from 4,631 KiB (849 KiB gzip) to 5,146 KiB (946 KiB gzip).
- Lint: the repository plugin `scripts/lint/agent-api-plugin.mjs` adds `agent-api/no-run-in-transaction`, `agent-api/no-run-below-entrypoint` (allow-listed files, `// lint: entrypoint` marker) and `agent-api/no-api-error-construction`; `complexity` and `no-nested-ternary` are errors under `packages/**`; `pnpm test:scripts` runs the plugin's rule tests.
- Error codes: `app_server_exited` is now `native_harness_exited`; `event_buffer_limit` is now `native_output_limit`.
- Limits: capability archives are 16 MiB per inline archive and 64 MiB per environment, extracted to at most 32 MiB and 10,000 entries; list pages stop at 4 MiB of serialized records; fork transcripts are 96,000 characters; the supervisor event log is 8 MB.
- Toolchain: Biome is replaced by ultracite (type-aware oxlint and oxfmt) and `@effect/tsgo`; `pnpm lint`, `pnpm format` and `pnpm effect:diagnostics` are the commands; `prepare` patches TypeScript and oxlint.
- Documentation rewritten for adopters: README, architecture with a turn sequence, compatibility with a per-harness matrix and the not-implemented list, deployment walkthrough, the Effect architecture page with its house rules and error vocabulary, known issues for OpenCode `1.18.30` message listing and rootless Docker.

### Removed

- `RpcResult`, `rpcFailure` and `unwrap` from the root import; the RPC envelope is internal.
- `docs/implementation.md`; its validation table lives in CONTRIBUTING.md.
- Every statement that the repository or its distribution is private.

### Earlier unreleased work folded into 0.2.0

- Claude Code and OpenCode reached the Codex surface: configured MCP servers, deferred functions with tool search, environment skills, plugins and capability directories, image input and results; session creation validates against driver capability flags.
- The Skills API with immutable versions and pinned session references; programmatic tool calling in isolated Dynamic Workers with an allowlisted tool bridge.
- Deployment-configured cross-runtime delegation (`delegates` on a preset exposes `cf_delegate`, `cf_wait`, `cf_close`); children run on their own harness in the parent's sandbox.
- The `/cf/v1` fork extension and `forkSession` RPC.
- A bounded native diagnostics tail logged from the Worker when an execution stops.
- Codex application profile: image input, text and image function results, reasoning summaries, token usage, configured web search, command deltas; input items broadcast; usage preserved through restore; partial output closed on cancellation.
- Service Binding, RPC, HTTP and library guides with runnable caller examples; agent settings and updates; hosted environment configuration, templates and files; artifacts; subagent projection; MCP and Vault integration.
- Environment, file transfer and credential workflows composed with Effect: typed I/O failures, interruption, serialized OAuth refresh, durable unknown outcomes; upstream redirects rejected without forwarding credentials.

## 0.1.0

- OpenAI SDK-compatible session and agent endpoints, tenant catalogs, Service Bindings, durable turns and items, live SSE and explicit event replay.
- Native Codex, Claude Code and OpenCode harnesses with a separate Sandbox, a private model gateway, and R2 conversation and workspace checkpoint recovery.
- Effect-based runtime contracts, typed failures and serialized lifecycle changes. Custom drivers return Effects; `fromPromiseDriver` adapts Promise implementations.
- Function tools, search provider helpers and immutable skill bundles.
- Cancellation remains recoverable when tool results arrive concurrently; completed checkpoint recovery tolerates lost responses and missing native processes.
- Idempotent session creation recovers its original reservation after saved-agent deletion. Serialized row limits reject oversized state with a structured 413.
- Effect is a shared peer dependency. Stable library dependencies use compatible ranges; the Sandbox preview SDK and image remain exactly paired.

This version implements the [alpha compatibility profile](https://github.com/inaridiy/CF-Open-Agents-API/blob/v0.1.0/docs/compatibility.md). The `v0.1.0` tag was created but never published to npm. It does not implement upstream subagents, artifact APIs or cross-harness forks.
