# Effect architecture

The application uses the pinned `effect@3.22.2`. HTTP, Workers RPC, SDK callbacks
and native process entrypoints keep their platform signatures. Reconciliation,
ownership changes, model routing, tool execution and checkpoint I/O compose
Effects internally. The native runtimes still own their agent loops.

## Contracts and failures

`runtime.ts` defines execution, command, event, batch and checkpoint contracts with
Effect Schema. Their TypeScript types are inferred from the schemas. `decodeEffect`
rejects excess properties at untrusted boundaries. The HTTP compatibility schemas
and native MCP/SDK schemas retain Zod where those integrations consume it.

`ApiError` is a tagged, yieldable domain error. `OperationError` identifies a failed
I/O operation and preserves its cause. Driver methods return
`Effect<A, ApiError | OperationError>`. The `io` adapter suspends Promise creation
until execution and supplies an interruption signal to APIs that can consume it.
There is no blanket retry of external writes. An unknown outcome remains explicit.

`runPromise` and `runSync` are boundary runners. They unwrap Effect's exit rather
than sending a FiberFailure wrapper across RPC, preserving the API's error name,
status and code. Synchronous Kysely transactions stay synchronous: their callback
type rejects both Promises and unevaluated Effects. SQLite commits/rollbacks the
record, turn, command and event changes together.

## Durable sessions

`SessionRecord` is an immutable discriminated union. An idle/failed record has no
execution; starting/running/checkpointing records require one. The same invariant
is validated with Effect Schema before writes and reconciliation. Session schema version 2 normalizes the legacy disabled-subagent limit on read;
legacy records are covered by restart tests. Checkpoint version 1 gains optional
artifact, environment-file and capability metadata without invalidating earlier checkpoints.

Reconciliation obtains its driver registry and timing policy through a Context
service and Layer. An Effect semaphore permits one reconciler per object while
input transactions remain available during network I/O. Each transition after I/O
rechecks both generation and turn ID against SQLite. In-memory synchronization is
an optimization; the durable state and execution identity remain authoritative.

Before sealing a completed turn, reconciliation checks commands committed during
polling and delivers them before polling again. Completion and command acceptance
therefore share one SQLite ordering point. A failed delivery does not become silent
success. Events and cursors commit atomically; gaps roll back the entire batch.

Once the phase is checkpointing, retries request the durable checkpoint directly.
They do not poll a possibly vanished native process first. A checkpoint is attempted
even after the execution deadline, so an already committed result can be recovered.
An incompatible checkpoint or a failed recovery after the deadline contains the
executor and fails explicitly. Cancellation/failure transitions also fence the
execution identity before changing state.

Cancellation has a separate durable operation record, so a rejected queued tool
result cannot prevent cancellation or terminal-state polling. The additive record
kind uses the existing SQL table; absent records mean no pending cancellation.
Legacy cancel commands are recognized and promoted on reconciliation. Downgrading
to a build without this record kind requires draining active turns first.

Session deletion is idempotent until catalog removal, allowing a lost response
between the two RPCs to be retried. Repeating catalog commit cannot resurrect a
previously committed and deleted session.

## Native resources and concurrency

Supervisor ownership lives in a Ref and changes under a semaphore. Start, control,
checkpoint and stop serialize against replacement. Tool and model callbacks remain
available during native startup. Request bodies are decoded before resolving their
target, so a delayed request cannot accidentally address the next job.

Native job outcomes and event logs share one immutable Ref state. Events use
Effect Chunk so appending a delta does not copy the entire retained log. Terminal outcomes
are absorbing: late tool results, completion callbacks or process errors cannot
turn a cancelled job back into running. Pending function calls use Deferred and
are settled during shutdown. Runtime consumption fibers belong to the job's Scope.
MCP servers and model body readers have finalizers, including on setup failure.

Operation IDs cache the complete Effect outcome and reject different input for the
same ID. An uncertain command failure is retained instead of executing the command
again. Checkpoint/stop use SynchronizedRef to join concurrent callers and cache a
successful result. Startup and teardown share the resource gate; stopping during
startup waits for acquisition and then closes the acquired resources.

Container lifecycle operations serialize against each other and workspace writes.
Snapshotting drains admitted workspace operations before capturing native/workspace
state. A delayed workspace request rechecks its assignment after taking the permit.
The durable dispatch marker still prevents replay of an acknowledged, vanished job.
These mechanisms do not make external tools or filesystem/R2 writes transactional
with SQLite; immutable checkpoints and explicit unknown outcomes remain necessary.

Delegated children are ordinary executions in their own HarnessDO, marked with a
`parent` so they neither reset the shared sandbox nor checkpoint. The parent
supervisor keeps each child's relay state in memory and its terminal status is
absorbing; the parent HarnessDO records the child's terminal batch durably before
destroying the child Container, so a lost poll response is answered from storage.
Parent shutdown tells children to cancel before closing the shared abort signal,
and the parent HarnessDO stops every recorded child before it releases the
sandbox, so a relay that never observed the cancellation cannot leave a child
running.

## Environments, files and credentials

`EnvironmentDriver` uses the same `Effect<A, ServiceError>` contract as the runtime
drivers. `EnvironmentWorkspace` composes configuration, setup, file writes and
restore internally; the Container RPC methods call `runPromise` at their boundary.
Setup reserves a durable pending state before running commands. Failure or
interruption stores a failed state, and another call cannot replay uncertain setup.
An inherited (forked) environment reserves the same pending state, applies the
network policy, variables and packages to the new sandbox before anything can
start it, and then adopts the source's committed base and capability roots.
Acquired command processes are killed if output collection fails or is interrupted.
SQLite upload journals remain synchronous, committed before writes to the live workspace.

Artifact transfer composes the producer and R2 sink with concurrent Effects.
Failure interrupts the sibling operation and aborts the producer's stream;
finalizers release the remaining streams. Immutable manifest entries are reused
on checkpoint retries, and incomplete uploads never become completed-turn artifacts.

Vault OAuth refresh uses a semaphore, reloads the credential after acquiring it,
and commits only if both its authentication fingerprint and reserved operation
still match. A manual rotation invalidates the old operation even when the token
value is unchanged. The HTTP exchange has a scoped cancellation handle and a
30-second timeout covering response headers and body. Unknown refresh outcomes
remain durable across object eviction until credential rotation.
MCP and native model requests reject redirects without forwarding credentials to
a new destination. Responses transferred to callers remain owned by those callers.

## Extension migration

`RuntimeDriver` methods now return Effects. Promise-based custom drivers can use
`fromPromiseDriver` while migrating. New implementations should compose Effects
and return typed failures directly. `EnvironmentDriver` methods also return Effects;
wrap an individual SDK/RPC call with `io`, and use `runPromise` only at platform boundaries. `batchSchema`, `executionSchema`,
`commandSchema`, `checkpointSchema` and `runtimeEventSchema` are Effect schemas;
replace `.parse(value)` with `decode(schema, value)` or `decodeEffect(schema, value)`.

`defineTool` accepts Effect input/output schemas and an Effect-valued `execute`.
Its `effect(input, context)` composes with other Effects; `call(input, context)` is
the Promise adapter for client SDK tool handlers. Model factories similarly expose
`effect(request)` alongside `fetch(request)`; `modelAdapter` adapts a custom Effect
implementation to the existing gateway contract. Search provider callbacks and
Cloudflare provisioning callbacks keep their Promise signatures.

## Evidence

The Worker suites exercise real workerd/SQLite, input/completion interleaving,
checkpoint response loss, overlapping alarms, batch rollback and deletion retries.
The Node concurrency suite exercises delayed request bodies, checkpoint/replacement,
operation deduplication, stop during acquisition, pending tools and concurrent
checkpoint readers. Native suites exercise actual Codex, Claude Code and OpenCode
with scripted models and history restored after the original home is removed.
Container smoke additionally exercises the real Worker/Container/R2 path.
See [CONTRIBUTING.md](../CONTRIBUTING.md#validation) for commands and
[GitHub Actions](https://github.com/inaridiy/CF-Open-Agents-API/actions) for results
for each committed revision.
