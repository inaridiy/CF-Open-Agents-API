# Changelog

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

This version implements the [alpha compatibility profile](docs/compatibility.md).
The npm dist-tag is `alpha`. It does not implement upstream subagents, artifact
APIs or cross-harness forks.
