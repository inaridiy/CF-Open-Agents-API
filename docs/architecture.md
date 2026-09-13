# Architecture

CF-Open-Agents-API implements the [alpha compatibility profile](compatibility.md)
on Cloudflare Workers. HTTP clients and trusted Service Binding callers share the
same durable session implementation. Native Codex, Claude Code and OpenCode own
their agent loops; the AI SDK adapts a single model inference at a time.

## Service boundaries

| Component | Responsibility |
| --- | --- |
| AgentWorker | Authentication, wire validation, tenant routing and HTTP/RPC responses |
| TenantCatalogDO | Tenant-scoped agents, session discovery and idempotent creation reservations |
| SessionDO | Input log, turns, required actions, output items, execution identity and events |
| HarnessDO | Container assignment, model egress, execution transport and checkpoint coordination |
| Harness Container | Node supervisor and the selected native runtime |
| SandboxDO / Sandbox Container | Separate workspace, shell and file execution environment |
| Private model gateway | Deployment-owned model registry, provider credentials and protocol translation |
| R2 | Native conversation checkpoints, workspace backups and immutable skill bundles |

The public `agent.model` selects a deployment preset mapping to a harness and a
model registry name. A session pins the harness revision and model registry name.
The deployment must version registry aliases if an old session must retain its
original upstream connection. Clients cannot supply provider URLs, credentials,
Container images, native binaries or host filesystem paths.

## Durable execution

SessionDO stores records and an ordered event log in SQLite. Kysely compiles SQL;
a small execution bridge runs it synchronously inside `transactionSync`. Input
validation, turn creation, commands and emitted events commit together. Network
I/O runs outside those transactions so new input can arrive while a driver polls.

Each execution has a session ID, turn ID and increasing generation. Every state
transition following I/O checks that identity against the current durable record.
An alarm reconciles starting, running and checkpointing phases; an Effect semaphore
prevents overlapping reconcilers in one object. SQLite remains authoritative after
object eviction. [Effect architecture](effect.md) describes the runtime contracts.

Start and control operations use stable operation IDs. A durable dispatch marker
prevents an acknowledged job from being replayed after its Container disappears.
A missing acknowledged execution fails with `outcome_unknown`: the input log does
not prove whether external effects already happened.

Cancellation takes precedence over queued steering and tool results. Its operation
ID remains durable until the native runtime reports a terminal outcome. A cancelled
turn returns the session to idle. Its uncommitted workspace and conversation state
are discarded when the next turn restores the last completed checkpoint.

## Checkpoints and recovery

A completed native turn first enters checkpointing. The supervisor shuts down the
native process before capturing its home, including native history databases and
transcripts. HarnessDO stores that snapshot in R2 and captures the assigned
workspace. SessionDO exposes completion only after committing both references.

Checkpoint retries read the durable checkpoint directly, so a lost response can be
recovered even after the native process disappears. Native revisions are checked
before restore. Codex uses a stable home path because its database contains absolute
rollout paths. Checkpoints do not preserve processes, sockets or external effects.

Session creation first reserves an idempotency key in the tenant catalog, then
initializes SessionDO and commits discovery. Retries recover the original reservation
before resolving mutable saved agents or model configuration. Deletion can be retried
between its SessionDO and catalog operations without resurrecting discovery.

## Models, tools and isolation

The private gateway maps assigned model names to AI SDK instances or native protocol
presets. Portable translation supports text and function calls; provider reasoning
state and extensions require native passthrough. See [model protocols](extending.md#model-protocols).

Codex connects to a remote exec-server in the Sandbox Container. Claude Code and
OpenCode use deployment-owned replacements for shell and file tools. Function calls
become durable required actions; clients submit the corresponding results. Model
credentials stay in the Worker, outside both execution Containers.

Skills are immutable, integrity-checked R2 bundles installed through a deployment
hook or read progressively through a function tool. They are input to untrusted
execution, not an authority to change Worker bindings or deployment policy.
See [SECURITY.md](../SECURITY.md) and [deployment](deployment.md) for operating boundaries.

## Streaming and limits

Live SSE reads persisted events under backpressure, with bounded per-listener
buffers. Disconnecting does not cancel a turn. Clients recover public state through
session/items/turns; `/cf/v1` also exposes explicit event replay.

HTTP body size and serialized storage size are separate limits. Records include
internal state and may repeat client fields, so SQL writes enforce a conservative
UTF-8 row budget before execution. Oversized input returns a structured 413 and its
transaction rolls back. Detailed limits are in [compatibility](compatibility.md#durability-and-limits).

Subagents, cross-harness forks, hosted artifact APIs and managed knowledge indexing
are outside the current alpha. Extension points do not imply support for those APIs.
