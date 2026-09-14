# Architecture

CF-Open-Agents-API implements the [compatibility profile](compatibility.md) on Cloudflare Workers. HTTP clients and trusted Service Binding callers share one durable session implementation. The native runtimes (Codex, Claude Code, OpenCode) own their agent loops; this project owns the API, the sandboxes, the model gateway and durability.

## Service boundaries

| Component                     | Responsibility                                                                                            |
| ----------------------------- | --------------------------------------------------------------------------------------------------------- |
| AgentWorker                   | Authentication, wire validation, tenant routing, HTTP routes and the typed RPC surface                    |
| TenantCatalogDO               | Per-tenant agents, templates, skills, vaults, input files, session discovery and idempotency reservations |
| SessionDO                     | One session: input log, turns, required actions, output items, execution identity and the event log       |
| HarnessDO                     | One session's execution: sandbox assignment, model and tool egress, delegated children, checkpoints       |
| Harness Container             | The Node supervisor and the selected native runtime; no Internet access                                   |
| SandboxDO / Sandbox Container | `/workspace`, shell, files, Codex `exec-server`, environment-origin MCP servers                           |
| `Models` entrypoint           | The private model gateway: deployment-owned model names, provider credentials, protocol translation       |
| R2                            | Native checkpoints, workspace backups, input files, skill bundles, environment configuration, artifacts   |
| `CODE_LOADER`                 | Dynamic Workers that run model-written code for programmatic tool calling                                 |

The public `agent.model` selects a deployment preset that maps to a harness and a gateway model name. A session pins the harness revision and the model name at creation. Changing a preset affects new sessions only. Clients cannot supply provider URLs, credentials, container images, binaries or host paths.

## A turn, end to end

```mermaid
sequenceDiagram
  participant C as Client
  participant S as SessionDO
  participant H as HarnessDO
  participant N as Supervisor
  participant X as Sandbox
  participant G as Model gateway
  participant R as R2
  C->>S: input.message (one SQLite transaction, alarm armed)
  S-->>C: 204
  S->>H: startExecution
  alt sandbox holds the committed workspace
    H->>X: reuse as is
  else
    H->>X: destroy, restore last backup, reapply configuration
  end
  H->>N: POST /jobs
  loop until the runtime stops
    N->>G: model request
    N->>X: bash / read / write / edit
    S->>H: pollExecution
    H->>N: GET /jobs/{turn}?after=
    N-->>S: events
    S-->>C: SSE, required_actions
    C->>S: tool_result or steer
    S->>H: controlExecution
  end
  S->>H: checkpointExecution
  H->>N: GET /jobs/{turn}/checkpoint
  H->>R: native.json, workspace backup, artifacts
  S-->>C: turn.completed, session.idle
```

## Durable execution

SessionDO stores records and an ordered event log in SQLite. Kysely compiles the SQL; a small bridge runs it synchronously inside `transactionSync`, so input validation, turn creation, queued commands and emitted events commit together. Network I/O runs outside those transactions, which is why new input can arrive while the reconciler is polling.

Every execution carries a session ID, a turn ID and an increasing generation. Each state change after I/O rechecks that identity against the durable record. A Durable Object alarm drives the reconciler. While a turn is active the alarm is re-armed before the reconciler takes its permit, so a busy reconciler can never consume the only wake-up. SQLite stays authoritative after eviction.

Start and control operations use stable operation IDs. HarnessDO writes a dispatch marker before it hands a job to the supervisor; a retry can inspect a lost job but never replay it. A job that was acknowledged and then vanished fails with `outcome_unknown`, because the input log does not prove whether side effects already happened.

Queued commands never block polling. A command the runtime refuses for good (`command_rejected`) is dropped: a refused steer becomes the next turn's input, a refused tool result is discarded. A transient delivery failure is retried after the next poll, so a turn the runtime already finished can still be sealed. Cancellation has its own durable record and supersedes queued steers and tool results.

The reconciler fails fast on a runtime protocol violation, an executor the deployment no longer registers, a harness revision mismatch, or a typed start rejection. It keeps retrying plain I/O failures until the turn deadline (`request_timeout`).

## Turn outcomes

A turn ends `completed`, `cancelled` or `failed`. A failed turn carries a `SessionTurnError` whose `code` is one of the SDK's public codes; any other string becomes `internal_error` with the original string as the message.

Only an indeterminate outcome leaves the session `failed`: `outcome_unknown`, `programmatic_execution_uncertain`, or any other `*_uncertain` code. Every other failed turn returns the session to `idle` with `session.error` set, and the next turn restores the last committed checkpoint. A `failed` session accepts no further input; fork it to continue.

## Checkpoints and recovery

A finished turn enters `checkpointing`. The supervisor stops the native process, then captures its home directory (history databases, transcripts, native subagent state). HarnessDO stores that snapshot in R2 under an immutable per-generation key, backs up `/workspace`, publishes `/workspace/outputs` as artifacts, and records the checkpoint locally. SessionDO exposes `completed` only after both references are committed.

Checkpoint retries read the recorded checkpoint directly and do not poll a native process that may be gone, so a lost response is recovered even after the container disappears. A checkpoint is attempted after the deadline as well, since the result may already be committed. The harness revision is checked before a checkpoint is restored. Codex uses a stable home path because its database stores absolute rollout paths. Checkpoints hold files, not processes, sockets or external effects.

## Sandbox reuse

HarnessDO records which workspace backup the live sandbox holds, both durably and as a marker file inside the container. When the next turn starts from that same committed workspace, the sandbox is reused as is, including state outside `/workspace` such as installed packages and files written by setup commands. Anything else (a cancelled or failed turn, a container the platform replaced, a fork adopting a workspace) destroys the sandbox, restores the last committed backup from R2, and reapplies the environment configuration. The deployment provisioning hook runs once per fresh workspace. Explicit environment uploads are reapplied from a durable file journal on restore. Setup-command effects outside `/workspace` therefore persist across reused turns and are discarded on restore; see [SECURITY.md](../SECURITY.md).

## Sessions, deletion and forks

Session creation reserves the idempotency key in the tenant catalog, initializes the SessionDO, prepares the environment, submits the initial input, and commits discovery. A retry recovers the original reservation before it resolves mutable saved agents or model configuration. Deletion marks the record deleted, removes catalog discovery, then purges the SessionDO's storage and leaves a tombstone so a lost-response retry still succeeds. A session listing tolerates a session deleted between the catalog page and its retrieval.

A fork follows the same reservation flow from a committed source. On the same harness revision, with the same tool surface, it copies the checkpoint references. Otherwise it adopts the source's committed workspace and capability roots into a new HarnessDO, applies the network policy before anything starts the new sandbox, and stores a bounded transcript that the first turn prepends to its input. Immutable checkpoint objects are shared, never copied or deleted by a fork.

## Models, tools and isolation

The private gateway maps deployment-owned model names to adapters. `nativeModel` passes a provider protocol through unchanged so provider reasoning state and extensions survive. `aiSDKModel` and `openAICompatibleModel` translate between the harness protocol and any AI SDK model; they carry text, images, function calls, reasoning effort and structured output, but not encrypted reasoning or hosted tools. See [model protocols](extending.md#model-protocols).

Codex connects to a remote `exec-server` in the sandbox container. Claude Code and OpenCode get deployment-owned replacements for their shell and file tools that call the sandbox. Function calls become durable `required_actions`; clients submit the results. Model credentials stay in the Worker, outside both containers. MCP servers with `connection_origin: "service"` are proxied by the Worker with Vault credentials; environment-origin servers run inside the sandbox behind a private bridge.

Skills are immutable, integrity-checked R2 bundles. They are input to untrusted execution, not an authority to change Worker bindings or deployment policy.

## Streaming and limits

Live SSE reads persisted events under backpressure with a bounded buffer per listener, sends a keepalive comment every 15 seconds, and delivers each event once. A creation request with `stream: true` returns a stream that ends when the initial turn settles, or right after `agent.session.created` when no input was given. Disconnecting never cancels a turn. `/cf/v1` exposes explicit event replay.

HTTP body size and serialized storage size are separate limits. Records include internal state and may repeat client fields, so SQL writes enforce a conservative row budget before execution; an oversized record is a structured 413 and its transaction rolls back. List pages stop growing past 4 MiB of serialized records. The values are in [compatibility](compatibility.md#durability-and-limits).

## Subagents and delegation

Subagents have their own items and turns. Native subagents run inside the runtime's own process: Codex threads, Claude Code's `Task` tool, OpenCode's `task` tool. Delegated children run on another preset's harness in a child HarnessDO and container named after the parent's subagent ID, share the parent's sandbox without resetting it, and are never checkpointed. The parent supervisor relays child events into its own ordered stream under the child's subagent and turn IDs, routes client function results to the child, and finishes only after its children stop. The parent HarnessDO records each child's terminal batch durably before it stops the child container, and stops every child before it releases the shared sandbox. Delegation does not nest.

## Effect

Internals compose Effect programs behind the platform entrypoints. The five house rules and the state of the ongoing migration are in [effect.md](effect.md).
