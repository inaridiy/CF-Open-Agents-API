# Compatibility profile

Profile: `cf-agents-v1-alpha`. Reference SDK: `openai@7.15.0`, `agents=v1`.
Native runtimes: Codex `0.154.0`, Claude Agent SDK `0.3.268`, OpenCode `1.18.30`. Query `/cf/v1/capabilities` for deployed models
and harness capabilities. This profile is a subset, not hosted-service parity.

| Surface | Current implementation |
| --- | --- |
| Agents | Create, retrieve, list, delete |
| Sessions | Create, retrieve, list, metadata update, delete when inactive |
| Inputs | Text messages, cancellation, string function results |
| Active input | Steers the existing Codex turn; Claude Code and OpenCode reject active steering |
| Output | Assistant text, function calls, command execution items |
| Streaming | Live SSE; durable replay is a separate `/cf/v1` extension |
| Turns | Retrieve and cursor-paginated list |
| Idempotency | Session creation and submitted input batches; conflicting reuse is 409 |
| Environment | `none`, or managed Cloudflare compute using the `openai_hosted` wire spelling |
| Native resume | Native history checkpoints for all three harnesses |
| Tools | Client function tools; schemas and helpers for application-owned tools |
| Harnesses | Codex, Claude Code, OpenCode; additional harnesses require a driver |
| Skills | Immutable R2 publishing/integrity checks, progressive read tool, sandbox provisioning hook |

Only fields described by exported Zod schemas are accepted. Unknown fields,
unsupported tool kinds, reasoning settings, media input, environment templates,
inline packages/plugins, vaults, artifacts, and subagent configuration are rejected.
`self_hosted.remote_url` is not emulated: this service does not implement OpenAI's
remote registration/Noise relay. Managed Cloudflare environments connect directly
to their assigned exec-server through a private Worker route.

A `model` in this API is a deploy-owned registry alias. Clients cannot select an
arbitrary provider URL, secret, container image, filesystem root, or harness binary.
Changing an alias does not migrate an existing session's pinned driver revision.
The model registry stores connection aliases; version them to preserve an old model mapping.

HTTP API errors follow the OpenAI error envelope. Common input/reservation validation failures cross DO RPC as result data.
Other API errors preserve a structured error name because Workers does not preserve
custom Error prototypes/properties. The HTTP adapter reconstructs status and code.

## Durability and limits

A completed turn means its native checkpoint and, when applicable, workspace
snapshot were uploaded and their references committed. Container processes, PTYs,
open sockets, and external side effects are not checkpointed. A lost acknowledged
execution fails with `outcome_unknown`; it is not restarted from the input log.
Cancellation supersedes queued steering and function results, stops the current
execution, and returns the session to idle after its native terminal outcome is
confirmed. A durable cancellation operation survives retries and object eviction. The next
turn restores the last completed checkpoint, so uncommitted cancelled-turn files
and native history are discarded.

Function results, metadata and inputs are session-scoped. Tenant catalogs isolate
session discovery. Service Binding callers are trusted to provide the correct tenant.

Request bodies are limited to 2 MB. Serialized SQLite records (including keys) are
limited to 1,900,000 UTF-8 bytes, reserving space below the platform's
[2 MB SQL row limit](https://developers.cloudflare.com/durable-objects/platform/limits/#sql-storage-limits).
Internal state can repeat input fields, so a smaller HTTP body can still produce
`413 storage_record_too_large`; its SQL transaction rolls back. The same storage
budget applies to Service Binding calls. Native snapshots are limited to 32 MiB, and the
supervisor's unacknowledged output buffer to 8 MB. Turns have a 15-minute default deadline, including external tool waiting.
Claude Code/OpenCode cap native turns at 32 steps. The AI SDK model adapter performs
one inference per native request, with 8,192 output tokens and a 120-second timeout
by default. The private gateway caps input at 4 MiB and output at 8 MiB. Incomplete
model output fails. See [model protocols](extending.md#model-protocols) for the portable
text/function profile and native reasoning passthrough.
SSE keeps a 64 KiB buffer per listener (plus at most one event) and reads persisted
events under backpressure; each session allows up to 64 listeners. Workspace backup TTL is 30 days; SDK restore expiry does not by itself
delete R2 objects. Configure retention/garbage collection explicitly before production.

The alpha does not implement cross-harness forks, cross-harness subagents, built-in
search-provider billing, the upstream skills/vault API, knowledge indexing, or an
artifact API. Tool/asset helpers and driver boundaries are extension points; they
are not advertised as completed API features.
