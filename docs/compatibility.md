# Compatibility profile

Profile: `cf-agents-v1-alpha`. Reference SDK: `openai@7.15.0`, `agents=v1`.
Native runtimes: Codex `0.154.0`, Claude Agent SDK `0.3.268`, OpenCode `1.18.30`.
This independent implementation lets you own the API, session state, native runtime
and model connections. Codex was the first target; Claude Code and OpenCode now
share the same environment, tool and subagent surfaces except where a native
runtime feature is unavailable. Full official API compatibility is still in progress.
Query `/cf/v1/capabilities` for deployed model aliases, delegation targets and
harness capability flags.

| Surface                   | Current implementation                                                                                                                                                                                            |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agents                    | Create, retrieve, list, update, delete; sessions keep their original agent configuration                                                                                                                          |
| Sessions                  | Create, retrieve, list with `agent_id` filtering, metadata update, delete when inactive                                                                                                                           |
| Inputs                    | Text and image messages, cancellation; string or content-array function results with images                                                                                                                       |
| Active input              | Steers the existing Codex turn; Claude Code and OpenCode reject active steering                                                                                                                                   |
| Output                    | Assistant text, function calls, command executions, MCP calls, reasoning summaries, usage; Codex web search and native collaboration items                                                                        |
| Streaming                 | Live SSE; durable replay is a separate `/cf/v1` extension                                                                                                                                                         |
| Turns                     | Retrieve and cursor-paginated list; completion follows durable checkpoint commit                                                                                                                                  |
| Usage                     | Per-turn and session token counts for all harnesses, cached input and reasoning output breakdown; preserved across eviction and native restore                                                                    |
| Runtime streaming         | Reasoning summary parts/deltas, command stdout deltas, user input notifications; partial output closes as incomplete at turn termination                                                                          |
| Idempotency               | Session creation, forks and submitted input batches; conflicting reuse is 409                                                                                                                                     |
| Agent settings            | Reasoning effort/summary, text verbosity/JSON schema and service tier applied natively by Codex; Claude Code maps a non-`none` effort to adaptive thinking; OpenCode records the settings without applying them   |
| Environment               | `none`, or Cloudflare Sandbox using the `openai_hosted` wire spelling                                                                                                                                             |
| Environment configuration | Environment variables, network policy, package installation, setup commands, initial files, inline skills/plugins, skill references and capability directories for every harness                                  |
| Templates                 | Tenant-owned create, retrieve, list, update and delete; confidential configuration is redacted from responses                                                                                                     |
| Files                     | Files API `user_data` upload/retrieve/list/content/delete; initial and later environment uploads using inline base64 or `file_id`; token-paginated environment listings                                           |
| Skills                    | `/v1/skills` create, retrieve, list, update, delete; immutable versions with default/latest selection and ZIP content download; sessions pin the resolved version                                                 |
| Artifacts                 | Immutable `/workspace/outputs` files published by completed turns; list, retrieve, download and delete                                                                                                            |
| Subagents                 | Codex native spawn/control projection; deployment-configured cross-runtime delegation for every harness; child state/items/turns and child function results; child completion waits for root checkpoint commit    |
| MCP                       | HTTP and stdio configuration, allowed tools and required servers for every harness; service-origin HTTP proxy with request metadata and attached Vault credentials; environment-origin servers run in the Sandbox |
| Vaults                    | Tenant-owned Vault/credential CRUD, redacted secrets, credential rotation, matching service-origin MCP authentication and serialized OAuth refresh                                                                |
| Function tools            | Client function tools, deferred loading and tool search for all three harnesses                                                                                                                                   |
| Programmatic tools        | `programmatic_tool_calling` runs model-written JavaScript in an isolated Dynamic Worker with an allowlisted tool bridge; requires the `CODE_LOADER` binding                                                       |
| Web search                | Codex `disabled`, `cached` and `live` modes, context size, domain filters and location; requires a supporting native Responses connection                                                                         |
| Native resume             | Native history checkpoints for all three harnesses                                                                                                                                                                |
| Forks                     | `/cf/v1` extension: continue a committed session on the same or another harness                                                                                                                                   |
| Harnesses                 | Codex, Claude Code, OpenCode; additional harnesses require a driver                                                                                                                                               |
| Asset helpers             | Immutable R2 publishing/integrity checks, progressive skill read tool and sandbox provisioning hook                                                                                                               |

The wire schemas reject unknown or unsupported fields. Input content consists of
text and images; Files API objects seed environments rather than appearing as
model input file parts. Environment-origin MCP request metadata and credential
selection are rejected; Vault authentication applies to service-origin HTTP MCP.
Reusable agents cannot store inline MCP secrets. Session responses omit inline
MCP authorization and headers. Function names `cf_execute`, `cf_tool_search`,
`cf_call_tool`, `cf_delegate`, `cf_wait`, `cf_close` and the workspace tool
names are reserved while the corresponding feature is enabled.

`self_hosted.remote_url` is not emulated: this service does not implement OpenAI's
remote registration/Noise relay. Managed Cloudflare environments connect directly
to their assigned exec-server through a private Worker route. Hosted-service
expiry, cleanup, encrypted reasoning content and nested subagent delegation
remain outside this profile.

A `model` is a deploy-owned registry alias. Clients cannot select an arbitrary
model-provider URL, container image, filesystem root, or harness binary.
Changing an alias does not migrate an existing session's pinned driver revision.
Version aliases to preserve an old model mapping. Codex settings require a model
connection that supports them: the example's `coding` alias uses native Responses
passthrough; the portable AI SDK adapter has a narrower text/function contract.
Images, native reasoning summaries, hosted web search and structured output require
a supporting native Responses connection. Harness capability flags describe the
runtime; they do not guarantee the selected provider's features or billing behavior.

## Capability flags

`/cf/v1/capabilities` reports each harness driver's flags and each agent alias's
`harness`, `model` and `delegates`. Session creation validates a configuration
against the flags of the selected alias's driver before any state exists:

| Flag                      | Gate                                                                                                            |
| ------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `functions`, `sandbox`    | Client function tools; `openai_hosted` environments                                                             |
| `images`                  | `input_image` messages and image function results                                                               |
| `mcp`                     | `mcp` tools                                                                                                     |
| `toolSearch`              | `tool_search` and `defer_loading` functions                                                                     |
| `webSearch`               | `web_search` tools (Codex)                                                                                      |
| `programmaticToolCalling` | `programmatic_tool_calling`; requires the `CODE_LOADER` binding                                                 |
| `environmentCapabilities` | Environment skills, plugins and capability directories                                                          |
| `subagents`               | Native subagents (Codex); delegation applies when the alias lists `delegates`                                   |
| `steer`                   | Input while a turn is active                                                                                    |
| `toolsFixedAtStart`       | The native thread cannot change its tool set after starting (Codex); forks that change tools carry a transcript |

Custom drivers declare the flags they implement; the Container drivers enable
everything above except native subagents and web search outside Codex.

## Application profile

The practical integration target is the official SDK's session lifecycle and
`sessions.stream(..., { toolHandlers })`: text/image input, function results,
reasoning/command output, cancellation, items/turns pagination and native history
restoration. SDK object tool results are JSON text; content arrays preserve text and
images in order. Function-call items represent generated calls; `required_actions`
and `function_call_output` indicate pending work and the result of executing it.
Claude Code and OpenCode receive images through a private media route; the
portable AI SDK profile still requires a provider that accepts them.

Usage is best effort. Each turn contains only its own reported inference usage;
session usage sums root and child turns without counting replayed batches twice.
Failed and cancelled turns retain observed usage because inference already
occurred. An unavailable report stays `null`; zero is not invented. Completion
events carry the same turn usage that retrieval returns. These counts are not an
OpenAI billing statement and cannot recover unreported usage after process loss.
Only reasoning summaries are exposed; private reasoning content is not projected.

### Subagents and delegation

Codex native subagents follow the runtime's own `spawn_agent` tools when
`multi_agent.enabled` is true. Delegation is deployment configuration: an agent
alias may list `delegates`, other aliases whose harness and model a child may run
on. With `multi_agent.enabled`, every harness then receives `cf_delegate`, `cf_wait`
and `cf_close`. A child runs in its own harness Container, shares the parent's
sandbox, receives the parent's client/MCP/code tools, and is projected as a
session subagent with its own turn and items. Child function calls become
`required_actions` with the child's `turn_id`. Parents complete after their
children stop; a cancelled or failed parent stops its children. Children are
single-turn and are not checkpointed; their workspace changes are committed with
the parent's checkpoint. Delegation does not nest.

### Forks

`POST /cf/v1/sessions/{id}/fork` (RPC `forkSession`) creates a new idle session
from a committed source: the source must have no active turn, and a failed
source with an indeterminate outcome is the intended recovery case. Overrides
follow the session-create `agent` shape; `metadata`, `input` and `vault_ids` are
optional. When the target harness revision matches, the fork continues the native
checkpoint, unless the runtime fixes its tools at thread start and the fork
changes the tool surface (tools, subagent enablement or delegation targets).
Otherwise the fork inherits the last committed workspace and receives a bounded
transcript of the source's public items as leading input on its first turn; that
transcript is consumed once the first turn completes. Forks share immutable
checkpoint objects with their source and start with an empty item list. Codex
also keeps the dynamic tool set its thread started with, so deployment changes
to `delegates` reach new sessions and transcript forks, not resumed threads.

| Hosted-service boundary                                                            | This deployment                                                            |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `openai_hosted`                                                                    | Cloudflare Sandbox with its configured network and storage                 |
| `self_hosted.remote_url`, Noise relay, environment connection handshakes           | Not implemented                                                            |
| Web search infrastructure                                                          | Provided by the configured Responses provider                              |
| Programmatic tool calling                                                          | Cloudflare Dynamic Workers through the `CODE_LOADER` binding               |
| OpenAI billing, organization policy, hosted expiry and physical garbage collection | Operator/provider responsibilities                                         |
| Nested delegation, resuming a delegated child                                      | Not supported; restored Codex children retain history but restart inactive |

See [environments, tools and delegation](environments-and-tools.md).

HTTP errors follow the OpenAI error envelope. Common input/reservation validation
failures cross DO RPC as result data. Other API errors preserve a structured error
name because Workers does not preserve custom Error prototypes/properties.
The HTTP adapter reconstructs status and code.

## Durability and limits

A completed turn means its native checkpoint, workspace snapshot and artifact
references were committed. Child terminal completion is committed with the root
checkpoint. Container processes, PTYs, open sockets and external side effects are
not checkpointed. A lost acknowledged execution fails with `outcome_unknown`;
it is not restarted from the input log. Fork the session to continue.

Cancellation supersedes queued steering and function results and returns the
session to idle after the native terminal outcome is confirmed. A durable
cancellation operation survives retries and object eviction. The next turn restores
the last completed checkpoint; explicit environment uploads are reapplied from a
durable file journal. Other cancelled-turn files and native history are discarded.
Environment setup with an unknown outcome is not replayed. OAuth refresh reserves
its operation before sending the request; a lost response requires credential
rotation instead of risking a second use of a rotating refresh token.

Programmatic code runs with no network, filesystem or credentials. Every tool call
it makes must be awaited; code that returns with calls outstanding, or whose
workspace effects cannot be confirmed, ends the turn as
`programmatic_execution_uncertain` and the sandbox is destroyed before the next
turn restores the last checkpoint. A delegated child in that state fails its
parent the same way.

Tenant catalogs isolate session discovery, input files, skills, templates and Vaults.
Service Binding RPC callers are trusted to provide the correct tenant; binding
HTTP requests still authenticate normally.

| Limit                                    | Current value                                                                                                                       |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| JSON request body                        | 16 MiB                                                                                                                              |
| Model input content                      | 100 parts/message or function result; image URL/data URL up to 1,000,000 characters, subject to SQLite record limits                |
| Initial environment files                | 50; inline 5 MiB/file and 10 MiB total                                                                                              |
| Files API `user_data` object             | 50 MiB/file; optional expiry 1 hour–30 days                                                                                         |
| Skill upload                             | 16 MiB archive, 32 MiB extracted; ZIP64, encrypted, symlink and device entries rejected                                             |
| Artifacts                                | 200 MiB/file and 500 MiB/turn                                                                                                       |
| Serialized SQLite record, including keys | 1,900,000 UTF-8 bytes                                                                                                               |
| Native checkpoint                        | 32 MiB                                                                                                                              |
| Supervisor output buffer per execution   | 8 MB, including streamed deltas and completed items                                                                                 |
| Turn deadline                            | 15 minutes by default, including external tool waiting and delegated children                                                       |
| Claude Code/OpenCode turn steps          | 32                                                                                                                                  |
| Portable AI SDK inference                | 8,192 output tokens; 120-second timeout by default                                                                                  |
| Private model gateway                    | 4 MiB input, 8 MiB output                                                                                                           |
| Programmatic code                        | 128 KB code, 1,000 ms CPU, 120 s wall time, 64 tool calls (8 concurrent), 128 KB arguments/call, 1 MiB results, 256 KB return value |
| Delegated children                       | `max_concurrent_subagents` (default 6); prompt up to 128,000 characters                                                             |
| Fork transcript                          | 96,000 characters; older entries omitted first                                                                                      |
| SSE                                      | 64 KiB/listener buffer plus at most one event; 64 listeners/session                                                                 |
| Workspace backup TTL                     | 30 days                                                                                                                             |

The SQL limit reserves room below the platform's
[2 MB row limit](https://developers.cloudflare.com/durable-objects/platform/limits/#sql-storage-limits).
Internal state can repeat input fields, so smaller HTTP bodies can still produce
`413 storage_record_too_large`; the SQL transaction rolls back. Large template
bodies and artifact manifests can reach this limit before the wire file limits.
Session configuration bodies live in R2; large template storage remains to be expanded.
The same storage budget applies to Service Binding RPC.

SDK restore expiry does not itself delete R2 objects. Session deletion removes
public discovery; physical retention/garbage collection remains an operator task.
See [checkpoint operations](deployment.md#checkpoint-operations).
Tests use scripted inference, including actual Codex and local Containers/R2.
They establish the exercised integration and recovery behavior, not model quality
or complete equivalence to the hosted OpenAI service.
