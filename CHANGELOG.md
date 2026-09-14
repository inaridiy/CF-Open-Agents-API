# Changelog

## Unreleased

- Bring Claude Code and OpenCode to the Codex surface: configured MCP servers,
  deferred functions with tool search, environment skills, plugins and capability
  directories, image input and results. Session creation validates against driver
  capability flags instead of harness names.
- Add the Skills API with immutable versions and pinned session references, and
  programmatic tool calling in isolated Dynamic Workers with an allowlisted tool bridge.
- Add deployment-configured cross-runtime subagent delegation: `delegates` on an
  agent preset exposes `cf_delegate`, `cf_wait` and `cf_close`; children run on their
  own harness in the parent's sandbox and project as session subagents.
- Add the `/cf/v1` fork extension and `forkSession` RPC: continue a committed or
  indeterminate session on the same harness with its native checkpoint, or on
  another harness with the inherited workspace and a bounded transcript.
- Keep a bounded native diagnostics tail in the supervisor and log it from the
  Worker when an execution stops; report the native reason behind `native_harness_failed`.
- Fix OpenCode workspace tools rejecting streamed command results, and apply the
  network policy to a forked sandbox before it starts.
- Extend the Codex application profile with image input, text/image function result
  arrays, reasoning summaries, token usage, configured web search and command deltas.
  Broadcast input items, preserve usage through restore, and close partial output on cancellation.
- Lead with the official OpenAI client over a Worker Service Binding; add runnable
  SDK/RPC caller examples and separate Service Binding, RPC, HTTP and library guides.
- Expand Codex compatibility with agent settings/update, hosted environment
  configuration/templates/files, immutable artifacts, subagent projection and MCP/Vault integration.
  Full parity remains in progress; see the current [compatibility profile](docs/compatibility.md).
- Compose environment, file-transfer and credential workflows with Effect, including
  typed I/O failures, interruption, OAuth refresh serialization and durable unknown outcomes.
- Preserve native Responses settings in the coding preset and reject upstream
  redirects without forwarding credentials to a new destination.

## 0.1.0 — Initial alpha

- OpenAI SDK-compatible session and agent endpoints, tenant catalogs, Service
  Bindings, durable turns/items, live SSE and explicit event replay.
- Native Codex, Claude Code and OpenCode harnesses with a separate Sandbox,
  private model gateway, and R2 conversation/workspace checkpoint recovery.
- Effect-based runtime contracts, typed failures and serialized lifecycle changes.
  Custom drivers return Effects; `fromPromiseDriver` adapts Promise implementations.
- Function tools, search provider helpers and immutable skill bundles.
- Cancellation remains recoverable when tool results arrive concurrently; completed
  checkpoint recovery tolerates lost responses and missing native processes.
- Idempotent session creation recovers its original reservation after saved-agent
  deletion. Serialized row limits reject oversized state with a structured 413.
- Effect is a shared peer dependency. Stable library dependencies use compatible
  ranges; the Sandbox preview SDK and image remain exactly paired.

This version implements the [alpha compatibility profile](https://github.com/inaridiy/CF-Open-Agents-API/blob/v0.1.0/docs/compatibility.md).
The npm dist-tag is `alpha`. It does not implement upstream subagents, artifact
APIs or cross-harness forks.
