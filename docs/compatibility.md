# Compatibility profile

Profile: `cf-agents-v1-alpha`. Reference SDK: `openai@7.15.0`, `agents=v1`.
Native runtimes: Codex `0.154.0`, Claude Agent SDK `0.3.268`, OpenCode `1.18.30`.

This is an independent implementation. It aims to let the official client work unchanged, with your own runtime, model and storage. It does not aim to reproduce OpenAI's hosted infrastructure, billing or policy. `GET /cf/v1/capabilities` returns the profile, the deployed presets (`harness`, `model`, `delegates`, `webSearch`) and each harness driver's capability flags.

## Surface

| Surface            | Implementation                                                                                                                                                                                                  |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agents             | Create, retrieve, list, update, delete. A session keeps the agent configuration it was created with. Saved agents cannot store inline MCP credentials.                                                          |
| Sessions           | Create (optionally with input and `stream: true`), retrieve, list with `agent_id` filter, metadata update, delete when no turn is active. `vault_ids` may be `null`.                                            |
| Input              | Text and image messages, cancellation, function results as a string or a content array with text and images. Input sent during a turn steers it on every harness.                                               |
| Output items       | Assistant text, function calls, command executions, MCP calls, reasoning summaries, web search calls, usage; Codex collaboration items for native subagents.                                                    |
| Streaming          | Live SSE on `/v1/agents/sessions/{id}/events` (long-polled from the runtime; keepalives; 64 listeners); creation streams ending after the initial turn; replay on `/cf/v1/sessions/{id}/events?after=`.         |
| Turns              | Retrieve and cursor-paginated list. `completed` means the checkpoint is committed. Failed turns carry the SDK's `SessionTurnError` codes.                                                                       |
| Usage              | Per-turn and session token counts with cached-input and reasoning breakdown for all harnesses, preserved across eviction and restore.                                                                           |
| Agent settings     | Reasoning effort and summary, `text.format` (`text` or `json_schema`), `text.verbosity`, `service_tier`, `multi_agent`. See [agent settings by harness](#agent-settings-by-harness).                            |
| Environment        | `none`, or `openai_hosted`, which runs on a Cloudflare sandbox here.                                                                                                                                            |
| Environment config | Environment variables, network policy, npm/python/system packages, setup commands, initial files (inline or `file_id`), inline skills and plugins, skill references, capability directories, for every harness. |
| Templates          | Tenant-owned create, retrieve, list, update, delete. Confidential values are redacted from responses. A session may narrow its template's network policy, never broaden it.                                     |
| Environments       | Retrieve (reports `pending`, `connected`, `disconnected` or `failed` and emits the matching session event), upload files, list files with `page`/`next` tokens.                                                 |
| Files              | Files API create with every `openai@7.15.0` purpose, retrieve, list with `purpose` filter, content, delete. Files seed environments; they are not model input parts.                                            |
| Skills             | `/v1/skills` create, retrieve, list, update, delete; immutable numbered versions with default and `latest` selection; ZIP content download. A session pins the version it resolved.                             |
| Artifacts          | Immutable copies of `/workspace/outputs` published by completed turns; list, retrieve, download, delete.                                                                                                        |
| Subagents          | Native subagents on every harness, deployment-configured cross-runtime delegation, child items and turns, child function results, child completion committed with the root checkpoint.                          |
| MCP                | HTTP and stdio servers, `allowed_tools`, `required`. Service-origin HTTP servers are proxied by the Worker with `request_metadata` and Vault credentials. Environment-origin servers run in the sandbox.        |
| Vaults             | Tenant-owned vault and credential CRUD, redacted secrets, rotation, static bearer and OAuth refresh credentials matched to service-origin MCP servers.                                                          |
| Function tools     | Client function tools, `defer_loading` and `tool_search`, for all three harnesses.                                                                                                                              |
| Programmatic tools | `programmatic_tool_calling` runs model-written JavaScript in an isolated Dynamic Worker with an allowlisted tool bridge. Requires the `CODE_LOADER` binding.                                                    |
| Web search         | `web_search` with `mode` (`disabled`, `cached`, `live`), `context_size`, `allowed_domains` and `location`, when both the harness and the preset support hosted search.                                          |
| Forks              | `POST /cf/v1/sessions/{id}/fork` and the `forkSession` RPC continue a committed session on the same or another preset.                                                                                          |
| Harnesses          | Codex, Claude Code, OpenCode. Other runtimes need a driver; see [extending](extending.md#additional-harnesses).                                                                                                 |

## Wire details

- Unknown or unsupported fields are rejected with `400 invalid_request`.
- Every response carries `x-request-id`. Permanent `409` conflicts (`idempotency_conflict`, `active_turn`, `session_failed`, `turn_checkpointing`, `active_turn_not_steerable`, `outcome_unknown`, `network_policy_conflict`, `invalid_session_state`, `not_deleted`, `environment_conflict`) carry `x-should-retry: false`, which the SDK honors.
- An absent or empty request body means `{}`; a fork needs no body.
- Errors use the OpenAI envelope: `{ error: { message, type, code, param } }`. `type` follows the status (`authentication_error`, `rate_limit_error`, `server_error`, otherwise `invalid_request_error`). Every `code` is projected from one tagged failure class by a single table (`toApiError` in `packages/agent-api/src/errors.ts`); the codes themselves are unchanged from earlier snapshots.
- Function tool names and MCP `server_label` values match `[A-Za-z0-9_-]{1,64}`. `cf_execute`, `cf_tool_search`, `cf_call_tool`, `cf_delegate`, `cf_wait`, `cf_close` and the workspace tool names (`bash`, `read`, `write`, `edit`) are reserved while the corresponding feature is enabled.
- Pages default to 20 records in descending order; `limit` is 1 to 100; `after` must belong to the collection.
- Idempotency keys cover session creation, forks, submitted event batches and skill uploads. Reusing a key with different input is `409 idempotency_conflict`.
- `last_active_at` moves when input is accepted and when a turn settles.
- Session responses omit inline MCP `authorization` and `headers`.
- Environment-origin MCP tools cannot carry `credential_id` or `request_metadata` (`422 unsupported_capability`).
- Tool results submitted for an unknown `call_id` return the exact `400` the SDK expects before retrying.

## Capability flags

`/cf/v1/capabilities` reports each driver's flags. Session creation validates a configuration against the flags of the selected preset's driver before any state exists.

| Flag                      | Gate                                                                                                                                  |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `functions`, `sandbox`    | Client function tools; `openai_hosted` environments                                                                                   |
| `images`                  | `input_image` messages and image function results                                                                                     |
| `mcp`                     | `mcp` tools                                                                                                                           |
| `toolSearch`              | `tool_search` and `defer_loading`                                                                                                     |
| `webSearch`               | `web_search` tools; the preset must also declare `webSearch: true`                                                                    |
| `programmaticToolCalling` | `programmatic_tool_calling`; true only when `CODE_LOADER` is bound                                                                    |
| `environmentCapabilities` | Environment skills, plugins and capability directories                                                                                |
| `subagents`               | Native subagents; delegation additionally requires `delegates` on the preset                                                          |
| `steer`                   | Input while a turn is active                                                                                                          |
| `toolsFixedAtStart`       | The runtime fixes its tool set at thread start (Codex); a fork that changes the tool surface carries a transcript, not the checkpoint |

The container drivers enable everything except `webSearch` on OpenCode. `programmaticToolCalling` follows the binding.

## Per-harness matrix

| Feature                  | Codex                                                                  | Claude Code                                                                           | OpenCode                                                                                     |
| ------------------------ | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Steering                 | `turn/steer` on the app-server                                         | The prompt iterable stays open; steered messages are injected with priority           | A `noReply` prompt stores the message; the loop answers it, or it is rerun before settlement |
| Native subagents         | Native threads (`multi_agent`, `max_concurrent_threads_per_session`)   | `Task` tool with one general-purpose definition, concurrency enforced in `canUseTool` | `task` tool with a subagent-mode agent; concurrency is best effort                           |
| Cross-runtime delegation | `cf_delegate`, `cf_wait`, `cf_close` when the preset lists `delegates` | Same                                                                                  | Same                                                                                         |
| Hosted web search        | Native Responses search tool, `mode` enforced at the gateway           | Anthropic hosted `WebSearch`, `allowed_domains` enforced                              | Not available                                                                                |
| Structured output        | `outputSchema` on `turn/start`                                         | `Options.outputFormat`                                                                | `StructuredOutput` tool; the validated value is the final answer                             |
| Reasoning effort         | `model_reasoning_effort`                                               | `Options.effort` (`minimal` becomes `low`; `none` disables thinking)                  | Provider variant per level (`minimal` to `max`); `none` sends nothing                        |
| Reasoning summary        | `model_reasoning_summary`                                              | Summarized thinking display when a summary is requested                               | Thinking deltas are projected as summaries when the provider streams them                    |
| `text.verbosity`         | `model_verbosity`                                                      | Recorded, not applied                                                                 | Recorded, not applied                                                                        |
| `service_tier`           | Sent on `turn/start`                                                   | Recorded, not applied                                                                 | Recorded, not applied                                                                        |
| Steps per turn           | Runtime default                                                        | 32                                                                                    | 32                                                                                           |
| Images                   | Native                                                                 | Private media route                                                                   | Private media route                                                                          |
| Native checkpoint        | `CODEX_HOME`                                                           | `CLAUDE_CONFIG_DIR`                                                                   | XDG data and state directories                                                               |

## Agent settings by harness

Settings are stored on every session and applied where the runtime supports them, as the matrix above shows. The model connection must support the setting as well: hosted web search, native reasoning summaries and encrypted reasoning need a `nativeModel` connection. The portable AI SDK adapter forwards reasoning effort (`max` rounds down to `xhigh`), structured output and images to any provider that accepts them, and drops what the provider cannot take.

## Subagents and delegation

With `multi_agent.enabled`, every harness may start native subagents. When the deployment also lists `delegates` for the session's preset, the runtime receives `cf_delegate`, `cf_wait` and `cf_close`. A delegated child runs on the delegate preset's harness and model in its own container, shares the parent's sandbox, receives the parent's client, MCP and code tools, and is projected as a session subagent with its own turn and items. Child function calls appear in `required_actions` with the child's `turn_id`. Parents complete after their children stop; a cancelled or failed parent stops its children. Children are single-turn, are not checkpointed, and their workspace changes are committed with the parent's checkpoint. Delegation does not nest.

## Forks

`POST /cf/v1/sessions/{id}/fork` (RPC `forkSession`) creates a new idle session from a committed source. The source must have no active turn; a `failed` source with an indeterminate outcome is the intended recovery case. Overrides use the session-create `agent` shape; `metadata`, `input` and `vault_ids` are optional. When the target harness revision matches and the tool surface is unchanged, the fork continues the native checkpoint. Otherwise it inherits the last committed workspace and receives a bounded transcript of the source's public items as leading input on its first turn. Forks share immutable checkpoint objects with their source and start with an empty item list. Codex keeps the tool set its thread started with, so deployment changes to `delegates` reach new sessions and transcript forks, not resumed threads.

## Not implemented

| Feature                                                   | Why                                                                                                                                                              |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `self_hosted` environments (`remote_url`, Noise relay)    | They need OpenAI's registration relay. Managed environments here connect to their sandbox over a private Worker route.                                           |
| Environment-origin MCP credentials and `request_metadata` | The sandbox filesystem would hold the secret. Vault credentials apply to service-origin HTTP servers, which the Worker proxies.                                  |
| Hosted web search on OpenCode                             | The harness container has no Internet egress and OpenCode has no hosted search tool that works through the gateway. Expose search as a function tool instead.    |
| Nested delegation                                         | Children are single-turn and cannot delegate; the parent tracks one level of children.                                                                           |
| Encrypted reasoning content                               | Only reasoning summaries are projected. Native passthrough keeps encrypted content inside the provider conversation; the portable adapter cannot replay it.      |
| Hosted expiry and cleanup                                 | File `expires_at` hides expired files from listings, but nothing deletes R2 objects. Session deletion purges SQLite and discovery, not checkpoints or artifacts. |
| OpenAI billing, organization policy, managed knowledge    | Operator and provider responsibilities.                                                                                                                          |

## Durability and limits

A `completed` turn means its native checkpoint, workspace backup and artifact references were committed. Container processes, PTYs, open sockets and external side effects are not checkpointed. A lost acknowledged execution fails with `outcome_unknown`; it is not restarted from the input log. Fork the session to continue.

A failed turn returns the session to `idle` with `session.error` set unless the outcome is indeterminate (`outcome_unknown` or any `*_uncertain` code), in which case the session stays `failed`. Cancellation supersedes queued steers and function results and returns the session to `idle` after the native outcome is confirmed. In both cases the next turn restores the last committed checkpoint: uncommitted workspace changes and native history are discarded, explicit environment uploads are reapplied from a durable journal.

While a session's sandbox holds the last committed workspace it is reused between turns, including state outside `/workspace`. After a cancel, a failure, a container loss or a fork, the sandbox is destroyed and restored from R2. Environment setup with an unknown outcome is not replayed.

Programmatic code runs with no network, filesystem or credentials. Every tool call it makes must be awaited; code that returns with calls outstanding, or whose workspace effects cannot be confirmed, ends the turn as `programmatic_execution_uncertain`, and the sandbox is destroyed before the next turn restores the checkpoint. A delegated child in that state fails its parent the same way.

Vault OAuth refresh reserves an operation before it sends the request. A definite `4xx` marks the credential `credential_refresh_rejected`; rotate it to recover. Only a lost response stays `outcome_unknown` until rotation.

Tenant catalogs isolate session discovery, input files, skills, templates and vaults. Service Binding RPC callers are trusted to provide the correct tenant; binding HTTP requests still authenticate.

| Limit                                    | Value                                                                                                                                   |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| JSON request body                        | 16 MiB (Files API 50 MiB, skill uploads 16 MiB, plus headroom)                                                                          |
| Input text                               | 128,000 characters per string input, text part or instructions                                                                          |
| Message content                          | 100 parts per message or function result; 64 tools per agent; 32 events per submission                                                  |
| Images                                   | URL or data URL up to 1,000,000 characters; 256 distinct remote images per request (`413 image_limit`); each remote fetch up to 1 MB    |
| Metadata                                 | 16 entries, keys up to 64 and values up to 512 characters                                                                               |
| Initial environment files                | 50 files; inline 5 MiB per file and 10 MiB in total                                                                                     |
| Capability archives                      | 16 MiB per inline skill or plugin archive; 64 MiB of inline archives per environment; 32 MiB and 10,000 entries extracted               |
| Files API object                         | 50 MiB per file; optional expiry from 1 hour to 30 days                                                                                 |
| Skill upload                             | 16 MiB archive, 32 MiB extracted, 1,000 entries; entries are repacked as regular files                                                  |
| Artifacts                                | 200 MiB per file and 500 MiB per turn                                                                                                   |
| Serialized SQLite record, including keys | 1,900,000 UTF-8 bytes (`413 storage_record_too_large`)                                                                                  |
| List page                                | Stops growing past 4 MiB of serialized records; `has_more` is set                                                                       |
| Native checkpoint                        | 32 MiB                                                                                                                                  |
| Supervisor event log per execution       | 8 MB, including streamed deltas (`native_output_limit` fails the turn)                                                                  |
| Turn deadline                            | 15 minutes by default (`maxTurnMs`), including tool waits and delegated children                                                        |
| Reconciler alarm                         | 5 seconds by default (`pollIntervalMs`); a tick long-polls the harness for the rest of its interval, at most 25 seconds per wait        |
| Claude Code / OpenCode steps per turn    | 32                                                                                                                                      |
| Portable AI SDK inference                | 8,192 output tokens; 120-second timeout by default                                                                                      |
| Private model gateway                    | 4 MiB request, 8 MiB response                                                                                                           |
| Programmatic code                        | 128 KB code, 1,000 ms CPU, 120 s wall time, 64 tool calls (8 concurrent), 128 KB arguments per call, 1 MiB results, 256 KB return value |
| Delegated children                       | `max_concurrent_subagents` (default 6); prompt up to 128,000 characters                                                                 |
| Fork transcript                          | 96,000 characters, 4,000 per entry; older entries are omitted first                                                                     |
| SSE                                      | 64 KiB queue per listener; 64 listeners per session (`429 stream_limit`); keepalive every 15 seconds; 64 events read per pull           |
| Workspace backup TTL                     | 30 days                                                                                                                                 |

The SQL budget stays below the platform's [2 MB row limit](https://developers.cloudflare.com/durable-objects/platform/limits/#sql-storage-limits). Records repeat input fields, so a body well under 16 MiB can still exceed a row; the transaction rolls back. Session configuration bodies live in R2. The same storage budget applies to Service Binding RPC.

Tests use scripted inference, including real Codex, Claude Code, OpenCode, local Containers and R2. They establish integration and recovery behavior, not model quality or complete equivalence to the hosted OpenAI service.
