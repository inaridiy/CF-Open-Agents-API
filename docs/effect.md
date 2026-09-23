# Effect architecture

The project uses `effect@3.22.2`. Platform entrypoints keep their platform signatures: Hono route handlers, Workers RPC methods, Durable Object alarms, Container RPC methods, native SDK callbacks and the supervisor's `main.ts`. Everything behind them composes Effect programs. This page states the five house rules and the mechanism that enforces each, then describes the pieces those rules produced: the layered error vocabulary, the repository seam around SQLite, the per-object runtimes, the reconciler, SSE streaming, the supervisor's job lifecycle and the long-poll between the two. [architecture.md](architecture.md) describes the same system in terms of durability; this page describes it in terms of code.

## The five house rules

| Rule                                                                                  | Enforced by                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. No `Effect.run*` below an entrypoint                                               | Lint: `agent-api/no-run-below-entrypoint` allows a runner only in the entrypoint files listed in `scripts/lint/agent-api-plugin.mjs`, and only on a line preceded by `// lint: entrypoint`. In the supervisor, runners exist in `server.ts` and `main.ts` only; that is checked by review.                                                                                                                                               |
| 2. No `yield*` inside a transaction callback                                          | Type: `Sync<A>` (`persistence/record-store.ts`, re-exported from `repo.ts`) and the callback type of `SqlStore.transaction` reject a Promise or an Effect as the callback's result; `tests/workers/state-contracts.ts` pins that with `@ts-expect-error`. Lint: `agent-api/no-run-in-transaction` catches a runner hidden inside the body of a `transaction`, `transactionSync` or `repo.read` callback.                                 |
| 3. Every `io` callback receives the signal; a non-idempotent write is uninterruptible | Type: `io(name, (signal) => promise)` declares the parameter itself (`effect.ts`), so `Effect.tryPromise` always creates the `AbortController`. Review: the writes wrapped in `Effect.uninterruptible` are the dispatch marker with its `POST /jobs`, the R2 puts for checkpoints, artifacts, input files and environment uploads, the catalog commit that makes a session discoverable, and the commit after an OAuth refresh answered. |
| 4. Every fiber has an owner                                                           | Review. In the Worker a fiber is owned by the entrypoint's `runPromiseExit` or by the `ReadableStream` that pulls it (SSE, streamed workspace output); nothing calls `forkDaemon`. In the supervisor every process, relay and consumer is acquired into a job's `Scope`; the one `forkDaemon`, in `Job.start`, exists so a stop requested from a native callback does not run on a fiber the stop interrupts.                            |
| 5. Errors are tagged or die                                                           | Type: `DomainError` is a closed union in `errors.ts`, the `WIRE` table `satisfies` a record over it, and the supervisor's `VERDICTS` is a record over its `Known` union, so an unmapped tag does not compile. Lint: `agent-api/no-api-error-construction` reserves `new ApiError(...)` for `errors.ts` and `api-error.ts`. Anything not tagged is a defect; boundary runners throw the squashed cause as itself.                         |

Two consequences of rule 3 are worth stating. Interrupting a fiber aborts an I/O whose API consumes the signal (`containerFetch` and `fetch` with `{ signal }`, a `pipeTo`, the container start) and orphans one that cannot (an R2 put, a Durable Object RPC call, `storage.setAlarm`): the call runs on, but the fiber no longer observes its outcome. A write whose outcome a later durable record depends on must therefore be `uninterruptible` at the call site, so an interrupt arrives after the outcome is known instead of turning a slow write into an unknown one. There is no blanket retry of external writes; an unknown outcome stays explicit (`outcome_unknown`, `*_uncertain`).

Rule 1 has two runners. `runPromise` settles an `Exit` and throws the squashed cause, so the failure's name and message cross Workers RPC as ordinary properties. `runSync` is for provably synchronous effects only: an effect that suspends leaves a running fiber, so `runSync` interrupts that fiber and throws an error naming the operation. The Worker's `runSync` sites are the sliding `PubSub` of `SessionObject` (its construction and the wake in `initialize`), the listener-permit probe and runtime capture in `stream`, the `encodeRpc` of synchronous RPC reads, and `decode`.

## Errors

`errors.ts` holds one tagged class per rule that can fail, in four layers. A class names the rule in its layer's own terms and carries the data a caller needs; none knows an HTTP status. Most classes are declared as one row of a `DEFINITE` table (tag, status, code, message) that a small helper turns into a class, so adding a rule is usually adding a row; about 21 classes are written by hand because something reads them as more than a projection — the `Enveloped` ones (`Schema.TaggedError`) whose values cross Durable Object RPC as data and decode back into instances on the caller, the two retryable ones, and the runtime answers that carry their own status, code or message. The rest, table-generated or not, are `Data.TaggedError`. Every definite failure reports its wire name through `name` (`AgentApiError:409:active_turn`), so a caller behind an un-enveloped RPC hop still recovers its status and code. `TransportFailure` and `StorageFailure` deliberately do not: a caller must never mistake them for a definite answer.

### Persistence

| Tag                   | Data                   | Meaning                                                                                                 | Wire                           |
| --------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------ |
| `RecordTooLarge`      | `bytes`                | A serialized row, keys included, exceeds the 1,900,000-byte budget; the transaction rolls back.         | 413 `storage_record_too_large` |
| `RecordNotFound`      | `kind`, `id`           | `RecordStore.require` found no row.                                                                     | 404 `not_found`                |
| `InvalidCursor`       | `reason?`              | `after` names no row of the collection under the same filter.                                           | 400 `invalid_cursor`           |
| `StorageFailure`      | `operation`, `cause`   | Something not in the transaction's error set was thrown inside the seam: an unknown outcome, retryable. | 500 `internal_error`           |
| `SessionNotFound`     |                        | The session record is missing or marked deleted.                                                        | 404 `not_found`                |
| `InvalidSessionState` | `reason`               | The persisted record is corrupt or of an unsupported version.                                           | 409 `invalid_session_state`    |
| `Superseded`          | `turnId`, `generation` | The durable execution identity moved on; the caller's work is void and stops silently.                  | 409 `stale_generation`         |
| `ContainerUnassigned` |                        | A HarnessDO row was read before any session was assigned to the container.                              | 409 `unassigned_container`     |

### Domain

Session rules, agent configuration, files, skills and credentials.

| Tag                              | Data                       | Meaning                                                                                         | Wire                                |
| -------------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------- |
| `IdempotencyConflict`            | `subject`, `reason?`       | A key was reused with different input.                                                          | 409 `idempotency_conflict`          |
| `SessionFailed`                  |                            | An indeterminate execution left the session failed; fork it or create a new one.                | 409 `session_failed`                |
| `TurnCheckpointing`              |                            | Input arrived while the turn's checkpoint is being committed.                                   | 409 `turn_checkpointing`            |
| `TurnActive`                     | `action` (`delete`/`fork`) | Deleting or forking needs a session whose turn has stopped.                                     | 409 `active_turn`                   |
| `SessionNotDeleted`              |                            | Purge was requested before deletion.                                                            | 409 `not_deleted`                   |
| `SteeringUnsupported`            | `harness`                  | Input arrived during a turn on a harness that cannot steer.                                     | 409 `active_turn_not_steerable`     |
| `UnknownToolCall`                | `callId`                   | A tool result names no pending call; the exact 400 the SDK retries on.                          | 400 `invalid_request_error`         |
| `ExecutorVersionIncompatible`    | `harness`, `revision`      | The deployment no longer registers the session's harness at its original revision.              | 503 `executor_version_incompatible` |
| `StreamLimitExceeded`            | `limit`                    | The 65th live stream on one session.                                                            | 429 `stream_limit`                  |
| `SubagentTurnMismatch`           | `subagentId`, `turnId`     | The turn exists but belongs to another subagent, or to none.                                    | 404 `not_found`                     |
| `CapabilityUnsupported`          | `capability`, `harness?`   | The selected harness, model alias or deployment cannot serve this configuration (`Capability`). | 422 `unsupported_capability`        |
| `ModelNotRegistered`             | `alias`                    | `agent.model` names no preset.                                                                  | 422 `unsupported_model`             |
| `DelegateUnavailable`            | `alias`                    | A listed delegate preset or its harness is not registered.                                      | 503 `delegate_unavailable`          |
| `ReservedToolName`               |                            | A function tool claims `cf_delegate`, `cf_wait` or `cf_close`.                                  | 400 `invalid_request`               |
| `McpPlacementInvalid`            | `rule`                     | Environment-origin MCP without an environment, or stdio MCP with service origin.                | 400 `invalid_request`               |
| `McpTransportUnsupported`        | `transport`                | A proxied server must be HTTP.                                                                  | 400 `invalid_request`               |
| `NetworkPolicyBroadened`         | `rule`                     | A session tried to widen its template's network policy.                                         | 400 `network_policy_broadened`      |
| `ImageLimitExceeded`             | `limit`, `scope`           | More distinct remote images than a request or a turn may reference.                             | 413 `image_limit`                   |
| `InputFileInvalid`               |                            | The Files API body is not a multipart file.                                                     | 400 `invalid_file`                  |
| `FileTooLarge`                   | `kind`                     | An input file (50 MiB) or an inline file (5 MiB) is over its limit.                             | 413 `file_too_large`                |
| `FileExpired`                    | `id`                       | The file's `expires_at` has passed.                                                             | 404 `not_found`                     |
| `SkillInvalid`                   | `reason`                   | A skill archive or manifest failed validation.                                                  | 400 `invalid_skill`                 |
| `SkillTooLarge`                  | `limit`                    | Upload, expanded, bundle or stored size over its limit.                                         | 413 `skill_too_large`               |
| `SkillVersionIsDefault`          | `version`                  | The default version cannot be deleted alone.                                                    | 409 `default_skill_version`         |
| `SkillPathInvalid`               | `path`                     | Traversal or an absolute path inside a bundle.                                                  | 400 `invalid_skill_path`            |
| `SkillManifestMissing`           |                            | A bundle has no `SKILL.md`.                                                                     | 400 `missing_skill`                 |
| `SkillMissing`                   | `reason`                   | The bundle is gone, or the skill is not installed.                                              | 404 `skill_missing`                 |
| `SkillFileMissing`               | `path`                     | `read_skill` named a file the bundle lacks.                                                     | 404 `skill_file_missing`            |
| `SkillIntegrityMismatch`         |                            | Stored content no longer matches its digest.                                                    | 409 `skill_integrity`               |
| `CredentialAmbiguous`            | `reason`                   | Several credentials match, or inline and vault authorization were both given.                   | 400 `ambiguous_credential`          |
| `CredentialNotFound`             |                            | No attached credential matches the server.                                                      | 404 `not_found`                     |
| `CredentialExpired`              | `reason`                   | The credential expired, or has no refresh configuration.                                        | 422 `credential_expired`            |
| `CredentialRefreshRejected`      |                            | The token endpoint refused the grant; only rotation clears it.                                  | 422 `credential_refresh_rejected`   |
| `CredentialRefreshFailed`        | `reason`                   | The endpoint failed, answered badly or timed out.                                               | 422 `credential_refresh_failed`     |
| `CredentialRefreshIndeterminate` |                            | A refresh whose answer was lost is still reserved; the token may have been consumed.            | 409 `outcome_unknown`               |
| `CredentialChanged`              |                            | The credential was rotated during a refresh.                                                    | 409 `credential_changed`            |
| `CredentialRotationInvalid`      | `rule`                     | A rotation changed the authentication type or method, or lacks refresh configuration.           | 400 `invalid_request`               |

### Runtime adapters

Runtime drivers, HarnessDO and the Containers, the environment workspace, the model gateway and programmatic tool calling.

| Tag                             | Data                        | Meaning                                                                                             | Wire                                   |
| ------------------------------- | --------------------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------- |
| `TransportFailure`              | `operation`, `cause`        | No answer, or an answer nobody can classify. The only retryable runtime failure.                    | 500 `internal_error`                   |
| `CommandRejected`               | `code`, `message`           | The runtime refused a command for good; it is dropped, never retried.                               | 409, its own `code`                    |
| `ExecutionMissing`              | `message`                   | The runtime owns no such job; a command cannot apply.                                               | 404 `execution_missing`                |
| `RuntimeRejected`               | `status`, `code`, `message` | A definite rejection of `start` or `checkpoint`; the turn fails with that code.                     | Its own `status` and `code`            |
| `InvalidRuntimeEvent`           | `code`, `message`           | A batch names state the session never created, or breaks the cursor sequence; the batch rolls back. | 409, its own `code`                    |
| `CheckpointIncompatible`        | `message`                   | The checkpoint cannot be restored by this driver.                                                   | 409 `invalid_checkpoint`               |
| `HarnessUnknown`                | `harness`                   | The execution names a Container harness the package does not ship.                                  | 400 `unsupported_harness`              |
| `CheckpointHarnessMismatch`     | `harness`, `revision`       | The checkpoint was written by another harness or revision.                                          | 409 `checkpoint_incompatible`          |
| `CheckpointMissing`             | `key`                       | The native checkpoint object is gone from R2.                                                       | 409 `checkpoint_missing`               |
| `AssignmentConflict`            | `sessionId`                 | The container already belongs to another session.                                                   | 409 `assignment_conflict`              |
| `NetworkPolicyConflict`         |                             | Network access must be configured before the sandbox starts.                                        | 409 `network_policy_conflict`          |
| `ArtifactListFailed`            |                             | Listing `/workspace/outputs` failed.                                                                | 503 `artifact_list_failed`             |
| `ArtifactLimitExceeded`         |                             | Artifacts exceed 200 MiB per file or 500 MiB per turn.                                              | 413 `artifact_limit`                   |
| `EnvironmentNotFound`           | `environmentId`             | No such environment.                                                                                | 404 `not_found`                        |
| `EnvironmentNotReady`           | `reason`                    | The source environment is not connected, or an upload arrived before connection.                    | 409 `environment_not_ready`            |
| `EnvironmentConflict`           | `environmentId`             | The harness already owns another environment.                                                       | 409 `environment_conflict`             |
| `EnvironmentSetupIndeterminate` |                             | Setup started and never committed; its commands may have run, so it is never replayed.              | 409 `outcome_unknown`                  |
| `EnvironmentSetupFailed`        | `reason`                    | A setup command failed, or a capability installation returned an invalid result.                    | 422 `environment_setup_failed`         |
| `EnvironmentWriteFailed`        | `reason`                    | A file or upload write into the sandbox failed, or the upload object is missing.                    | 503 `environment_write_failed`         |
| `EnvironmentListFailed`         |                             | Listing environment files failed.                                                                   | 503 `environment_list_failed`          |
| `EnvironmentDriverUnavailable`  |                             | The deployment configured no environment driver.                                                    | 503 `environment_unavailable`          |
| `BackupCredentialsMissing`      | `missing`                   | The Sandbox SDK's R2 secrets are unset; the driver's `preflight` answers creation before a reserve. | 503 `environment_unavailable`          |
| `CapabilityBudgetExceeded`      |                             | Skills and plugins exceed 64 MiB per environment.                                                   | 413 `capability_limit`                 |
| `StoredObjectMissing`           | `object`                    | An object a durable record names is gone from object storage.                                       | 404 `not_found`                        |
| `ObjectStorageUnavailable`      |                             | The route needs an R2 bucket the deployment did not configure.                                      | 503 `storage_unavailable`              |
| `UpstreamRedirect`              | `operation`                 | A configured upstream answered with a redirect; credentials never follow one.                       | 503 `upstream_redirect`                |
| `ModelNotFound`                 | `model`                     | The gateway registry has no entry of that name.                                                     | 404 `model_not_found`                  |
| `ModelProtocolMismatch`         | `protocol`                  | A `nativeModel` entry cannot answer the harness protocol.                                           | 400 `model_protocol_mismatch`          |
| `ModelInputMissing`             |                             | The harness request carried no input.                                                               | 400 `missing_model_input`              |
| `ModelInputTooLarge`            |                             | The gateway request exceeds 4 MiB.                                                                  | 413 `model_input_too_large`            |
| `ModelInputUnsupported`         |                             | The portable adapter cannot translate provider-specific content.                                    | 400 `unsupported_model_input`          |
| `ModelOutputFailed`             |                             | The upstream output failed or was incomplete.                                                       | 503 `model_output_failed`              |
| `ModelUpstreamRejected`         |                             | The upstream answered with an error before any output; `fallbackModel` tries the next model.        | 503 `model_upstream_rejected`          |
| `ProgrammaticExecutionFailed`   | `reason`                    | Model-written code failed definitely.                                                               | 422 `programmatic_execution_failed`    |
| `ProgrammaticOutcomeUncertain`  | `reason`                    | A tool call ended without a confirmed result; the code may have had effects.                        | 422 `programmatic_execution_uncertain` |
| `ProgrammaticInputTooLarge`     |                             | Code and arguments exceed 256 KB.                                                                   | 413 `programmatic_input_too_large`     |

### Wire

| Tag              | Data     | Meaning                                                 | Wire                  |
| ---------------- | -------- | ------------------------------------------------------- | --------------------- |
| `InvalidRequest` | `issues` | A body, query or RPC argument failed schema validation. | 400 `invalid_request` |
| `InvalidJson`    |          | The body is not JSON.                                   | 400 `invalid_json`    |
| `InvalidTenant`  |          | The tenant is empty or longer than 256 characters.      | 400 `invalid_tenant`  |
| `Unauthorized`   |          | `authenticate` resolved no tenant.                      | 401 `unauthorized`    |
| `BodyTooLarge`   |          | The body exceeds the route's upload limit.              | 413 `body_too_large`  |

### Projection and transport

`toApiError` at the end of `errors.ts` is the only place that maps a tag to `(status, code)`: the `WIRE` table `satisfies` a record over every static tag, and the three dynamic tags (`RuntimeRejected`, `CommandRejected`, `InvalidRuntimeEvent`) carry their code in their data. `ApiError` (`api-error.ts`) is only that projection and the reconstruction of one from an RPC wire name (`remoteApiError`); `caughtFailure` turns anything a boundary catches into a tagged failure or nothing, and `projectApiError` into its projection. `isPermanent` names the conflicts a retry cannot resolve; the HTTP error handler in `http/app.ts` sets `x-should-retry: false` from it. `ServiceError`, the error type of an `EnvironmentDriver` method and of the exported tool helpers, is `DomainError | OperationError | ApiError`: `OperationError` (`effect.ts`) is what `io` and `attempt` produce for an untagged cause, and `ApiError` appears only when a definite failure arrived through an un-enveloped RPC hop.

Two transports carry a failure across Durable Object RPC, and `errors.ts` states why both exist. A failure thrown out of an RPC method reaches its caller as an ordinary `Error`, and `remoteApiError` recovers its status and code from the wire name `name` carries; that is how about sixty methods answer, and it is enough, because no caller reads a failure's fields after such a hop. What it costs is that nothing records the throw: the platform delivers the rejection to the caller and logs no exception on the callee (a tail shows the callee's event as `ok`), so a caller that absorbs such a failure logs it itself, as the environment setup path does. Four calls expect their failure as an ordinary outcome of a retried request instead — the catalog's reservation and reserve, the fork's source read and a session's submit — so they use the envelope below: the callee returns normally, nothing is logged, and the caller's fiber still fails with the decoded instance rather than a projection of it.

Between Durable Objects, expected failures travel as data rather than as platform exceptions. `rpcEnvelope(success)` is `Schema.Either({ left: RpcFailure, right: success })`, where `RpcFailure` is the union of the `Schema.TaggedError` classes plus `ApiErrorSchema`. The callee runs `encodeRpc(envelope, program)`: a failure in the union becomes `Either.left`, everything else still throws. The caller runs `decodeRpc(envelope)(encoded)`, which decodes the envelope and fails the fiber with the instance, so `catchTag` works on the caller's side. Results whose types are too deep for the RPC stub (`ForkSourceResult`, `ReservationResult`, `ReserveResult`) travel as `Schema.parseJson` strings.

The supervisor keeps its own vocabulary, one section per layer: `lifecycle.ts` (`InvalidCursor`, `ExecutionStopped`, `ExecutionCancelled`, `CheckpointUnavailable`, `CommandRejected`, `ExecutionMissing`, `IdempotencyConflict`, the slot verdicts `ExecutionSuperseded`, `AssignmentConflict`, `ExecutionActive`, `ExecutionAlreadyFailed`, `UnsupportedHarness`), `process.ts` (`ProcessGone`, `StartupTimeout`, `NativeStartupFailed`, `NativeExited`, `NativeTurnFailed`), `json-rpc.ts` (`RpcError`, `TransportClosed`, `RpcTimeout`), `delegation.ts`, `remote-tools.ts`, `checkpoint.ts`, `programmatic.ts`, `workspace.ts` and `media.ts`. `toResponse` in `server.ts` is its one projection: `409 command_rejected` for a command that can never apply, `404 execution_missing` for an unknown job, `400 invalid_request` and `400 unsupported_harness` for a bad request, `409 idempotency_conflict`, `stale_generation`, `assignment_conflict`, `active_execution` and `native_start_failed` for a start the slot refuses, and `500 internal_error` for every other tag, which the HarnessDO treats as transient. Nothing below `server.ts` knows a status. A job fails with one of `TURN_ERROR_CODES` (the SDK's `SessionTurnError` codes); any other string reaches the client as `internal_error` with the string as the message.

## The repository seam

The seam is the unit of work. Everything that must be atomic with a SQLite write is a synchronous function of a typed transaction view; everything that performs I/O or waits is an Effect that calls the repository zero or more times. The modules live in `packages/agent-api/src/persistence/`.

| Module              | Contents                                                                                                                                                                                                                                                               |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kind.ts`           | `Kind<A>`, a phantom-typed record kind: the value type follows the kind, a plain string is not one.                                                                                                                                                                    |
| `record-store.ts`   | `RecordStore` (get, require, put, remove, clear, list, append, events, lastEvent, outputKey, purge), `Transactional` (one method, `transaction`), `Sync<A>`, and the page helpers `eachPage`, `eachRecord`, `mapPage`, `resourcePage`. Synchronous and free of Effect. |
| `memory-store.ts`   | `MemoryStore`, a `RecordStore` over Maps with snapshot-and-restore rollback, for policy unit tests only.                                                                                                                                                               |
| `row.ts`            | `encodeRow`, the 1,900,000-byte budget that throws `RecordTooLarge`.                                                                                                                                                                                                   |
| `repo.ts`           | `Repo<Tx, E>` and `makeRepo`, the Effect edge of the seam; re-exports `Sync<A>` from `record-store.ts`.                                                                                                                                                                |
| `session-kinds.ts`  | `SessionKinds`: every kind a session object stores, typed.                                                                                                                                                                                                             |
| `session-record.ts` | `SessionRecord`, `ActiveSession`, `Fenced<A>`, `migrate`, `validate`; the phase/execution invariant as a schema.                                                                                                                                                       |
| `session-tx.ts`     | `SessionTx` and `makeSessionTx`; `fenced(execution)` is the one place the brand is applied.                                                                                                                                                                            |
| `session-repo.ts`   | `SessionTxError`, `SessionRepo = Repo<SessionTx, SessionTxError>`, `makeSessionRepo`.                                                                                                                                                                                  |
| `harness-kinds.ts`  | `HarnessKinds` (assignment, sandbox, child, checkpoint, artifacts) and their record types.                                                                                                                                                                             |
| `harness-tx.ts`     | `HarnessTx`, `HarnessTxError` (`RecordTooLarge \| ContainerUnassigned`), `HarnessRepository`, `makeHarnessRepo`.                                                                                                                                                       |

`SqlStore` (`storage.ts`) is the one durable `RecordStore` and `Transactional`; its SQL is unchanged from before the seam existed. `CatalogObject`, `SkillRepository`, `VaultRepository` and `EnvironmentWorkspace` declare their own `Kinds` over the same store.

```ts
/** A synchronous result: returning a Promise or an Effect from the seam is a type error. */
export type Sync<A> = A &
  (A extends PromiseLike<unknown> | Effect.Effect<unknown, unknown, unknown> ? never : unknown);

export interface Repo<Tx, E> {
  readonly transaction: <A>(f: (tx: Tx) => Sync<A>) => Effect.Effect<A, E | StorageFailure>;
  readonly read: <A>(f: (tx: Tx) => Sync<A>) => Effect.Effect<A, E | StorageFailure>;
}
export type SessionRepo = Repo<SessionTx, SessionTxError>;

export interface SessionTx {
  readonly store: RecordStore; // kinds without a dedicated accessor
  session(): SessionRecord | undefined; // migrated and validated
  requireSession(): SessionRecord; // throws SessionNotFound, InvalidSessionState
  save(record: SessionRecord): void; // validates the phase/execution invariant
  emit(event: AgentSessionEvent): void;
  turn(id: string): Turn | undefined;
  requireTurn(id: string): Turn; // throws RecordNotFound
  putTurn(turn: Turn): void;
  commands(limit: number): Command[];
  cancellation(turnId: string): Command | undefined;
  fenced(execution: Execution): Fenced<ActiveSession>; // throws Superseded
}
```

`transaction` runs the callback in one `transactionSync`. A throw rolls the transaction back and then becomes the failure channel: a class in the transaction's error set (`SessionTxError` lists the persistence failures and the state machine's own rules) fails typed, anything else is a `StorageFailure`. `read` runs the callback against the same view without a transaction. Both are lazy (`Effect.suspend`), so constructing the effect runs nothing and the callback runs on the fiber's current tick; there is no `sleep` between reading a record and the fenced write that follows, because the fence exists precisely because there cannot be one.

`Fenced<ActiveSession>` is a brand on a private `unique symbol` that only `session-tx.ts` applies, after re-reading the record inside the current transaction and matching its generation and turn to the caller's execution. The reconciler's transitions in `session-state.ts` (`markRunning`, `acceptBatch`, `commitCheckpoint`, `complete`, `reject`, `discard`) take a `Fenced<ActiveSession>`, so a transition on a record read before an awaited poll or checkpoint does not compile; a spread of a fenced record keeps the brand, so a transition derives its next record from the value it was given. The unfenced writes are the ones whose read and write share one synchronous step of a serialized call: `initialize`, metadata `update`, `applyEnvironmentStatus`, `markDeleted`, and `acceptInput` (which starts a turn through `begin`). `state-contracts.ts` pins these rules with `@ts-expect-error`.

`MemoryStore` stores rows serialized so reads hand out fresh values as SQLite does, applies the row budget, and rolls back on throw. It does not reproduce SQLite's ordering, pagination or page byte budget; a test whose subject is any of those runs on `SqlStore` in workerd.

## Per-object runtimes

`SessionObject` builds one `ManagedRuntime` per object (`session-services.ts`) from exactly three services, the only ones a test substitutes:

| Service   | Provides                                                                                                                                                                          |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Drivers` | `get(name)` as an `Option` of `RuntimeDriver`, the `agents` presets, `maxTurnMs`, `pollIntervalMs`, `keepaliveMs`. Read through `dependencies()` on every access, never captured. |
| `Alarm`   | `arm(inMs)` and `clear`, over `storage.setAlarm` and `deleteAlarm`. Alarms take no signal, so an interrupted fiber orphans the platform call.                                     |
| `Repo`    | The `SessionRepo`, wrapped so every committed `transaction` publishes to the wake `PubSub`.                                                                                       |

Time comes from Effect's `Clock`, so `TestClock` applies. The layers hold no resources, so an evicted object leaks nothing by never disposing its runtime. Every asynchronous entrypoint (`submit`, `alarm`, `environmentStatus`, `delete`, `purge`) runs its program through `runtime.runPromiseExit(program).then(settle)`; the plain RPC reads (`retrieve`, `items`, `turns`, `forkSource`, `replay`) use the synchronous `SessionTx` directly and throw tagged errors whose wire name survives RPC. `HarnessContainer` has its own `ManagedRuntime` with `HarnessRepo` (the `HarnessRepository`) and `HarnessBindings` (the Worker environment); its `publishArtifacts` copies four files at a time with `Effect.forEach(..., { concurrency: 4 })`, each copy handling its own interruption through `copyKnownLength`.

## The reconciler tick

`alarm()` runs `alarmProgram`: while a turn is active it re-arms the alarm one interval ahead before taking the object's single permit (`withPermitsIfAvailable(1)`), so a busy reconciler cannot consume the only wake-up; the tick runs under that permit with `catchAllCause` logging, and `ensuring` re-arms once it settles, for one interval after this alarm fired or at once when the tick outlasted it. Alarms remain the durable clock: nothing in the object loops on `Schedule` between alarms.

`reconcileTick` (`session-reconcile.ts`) is one `Effect.fn` program. It reads the session, returns if no execution is active, arms the alarm before any I/O, and resolves the driver; a driver the deployment no longer registers fails the turn with the message `executor_unavailable` (public code `internal_error`), a revision mismatch with the SDK code `executor_version_incompatible`. A turn already `checkpointing` goes straight to checkpoint recovery. Otherwise the tick starts the runtime when the phase is `starting` (then `markRunning` under the fence) and runs command-and-poll rounds with `Effect.repeat` while a round answers `again`: the round repeats at most 16 times for a driver polled once per alarm, and 1,000 times for a long-polling driver, whose rounds are bounded by the tick's time budget instead.

One round re-reads the fence, fails the turn with `request_timeout` past the deadline, reads the pending commands (a cancellation supersedes queued input) and delivers them. Delivery never blocks the poll: `catchTags` on `control` drops a `CommandRejected` or `ExecutionMissing` command (a refused steer is re-queued as the next turn's input through `reject`), and on a `TransportFailure` polls first and retries delivery on the next round, so a turn the runtime already finished can still be sealed. The poll asks for `waitMs` equal to the rest of the tick's budget (the alarm's start plus `pollIntervalMs`, bounded by the turn deadline, less a 500 ms margin, at most 25 s), or zero while the session is `requires_action` or the driver has no `longPoll`. `acceptBatch` applies the batch inside one fenced transaction; an `InvalidRuntimeEvent` rolls the whole batch back. A batch that completes the turn moves it to `checkpointing` and commits the checkpoint in the same tick; a failed, missing or cancelled outcome stops the driver and seals the turn (`outcome_unknown` for a missing job). A poll that answered early with news keeps polling while the tick has budget.

The error policy is a type. `Superseded` ends the tick silently, because the winner owns the record. `RuntimeRejected`, `InvalidRuntimeEvent`, `RecordTooLarge` and `InvalidSessionState` seal the turn with the code they project to. `TransportFailure` and `StorageFailure` propagate: the alarm logs them and the next alarm retries, until the deadline. Checkpointing follows the same shape and is attempted after the deadline too, since the result may already be committed; only a failure to answer after the deadline becomes `internal_error` with the message `checkpoint_unavailable`. The stop before a seal is bounded the same way: past the deadline a stop that still fails seals the turn as `outcome_unknown`.

## SSE streaming

`stream(after, { initial })` on `SessionObject` returns a `Response` whose body is `Stream.toReadableStreamRuntime(events, runtime, { highWaterMark: 64 KiB })`. The `ReadableStream` owns the fiber: back-pressure is its byte queue, and cancelling it (the client went away) interrupts the fiber, which releases the listener permit and the wake subscription through their scope. The listener cap is a `Semaphore(64)`, probed synchronously in `stream` and held by the stream's scope; the 65th request fails with `StreamLimitExceeded`.

One listener is `Stream.paginateEffect` over pages of 64 events read from SQLite by cursor. When a page is empty the fiber waits on its subscription to the object's `PubSub.sliding(1)` wake, which every committed repository transaction publishes to; the subscription is taken before the first read, so a commit between a read and the wait is not missed, and a listener that lagged sees at most one pending tick, which is enough because it reads by cursor. The event stream is merged (`haltStrategy: "left"`) with a keepalive comment from `Stream.fromSchedule(Schedule.spaced(keepaliveMs))`, ended by `takeUntilEffect` when a creation stream's initial turn settles (or right after `agent.session.created` without input), interrupted by a `Deferred` that `delete` and `purge` complete, rechunked to one event per chunk so the queue's byte budget is checked before each one, and encoded as text. Frames are unchanged: `id`, `event`, `data`. The only synchronous wake is the one in `initialize`, which runs outside the runtime; publishing to a sliding `PubSub` never suspends.

## The supervisor

`process.ts` owns native processes: `acquireProcess(spawn, grace)` and `ownProcess(child, grace)` put a `ChildProcess` into the current `Scope`, whose close runs `terminate` (SIGTERM, wait up to the grace period, SIGKILL, then wait for exit); `awaitExit`, `exitedWithin` and `awaitReady(child, ready, bound)` are the process events as Effects, listeners detached when the wait settles or is interrupted.

`lifecycle.ts` holds `JobLog`, the retained event log and outcome of one job (8 MB budget, `native_output_limit` past it, terminal outcomes absorbing, `requestCancel` so a completion that follows reads as cancelled, `close` to seal). Native callbacks mutate it synchronously, outside any fiber; `Wake` is the edge trigger that lets `poll(after, wait)` suspend until the next change. `within(wait, bound)` is the one wait-or-give-up policy, opting back into interruption so the bound also holds inside finalizers. `Operations.perform` memoizes the whole outcome of an operation ID with `Effect.cached`, failures included, so an indeterminate write is never replayed; `once` joins concurrent callers and allows a retry after failure.

`json-rpc.ts` is Codex's stdio transport: `AppServer.acquire(options)` spawns into the caller's `Scope`, routes stdout lines from `Stream.fromAsyncIterable` into per-request `Deferred`s and a `Queue` of notifications, and registers its close before the process so pending requests learn of the exit; `request` fails with `RpcError`, `TransportClosed` or `RpcTimeout` (60 s).

`job.ts` is the lifecycle every native runtime shares. `start` creates the job's `Scope` and registers the stop sequence as finalizers; every process, fiber and relay is acquired into a child scope that closes last. Finalizers run in reverse registration order, so `stop()`, which closes the `Scope`, is the only definition of shutdown:

1. `requestCancel` on the log, so a completion that arrives meanwhile reads as cancelled.
2. `delegations.cancelAll`, cancelling delegated children while the route is open.
3. `interruptTurn`, the runtime's bounded graceful interrupt.
4. The log is sealed.
5. The job's `AbortController` aborts SDK consumption.
6. Pending client tool calls are failed (`abandon`).
7. `teardown`: the native runtime client is closed (`closeRuntime`), bounded by the adapter.
8. The child scope closes: MCP clients are released, task and relay fibers are interrupted and awaited, processes terminated.

Native SDK callbacks run outside any fiber; `perform` hands their Effects to a worker fiber the resource scope owns, so stopping interrupts them. `control` runs under `Operations.perform`; a cancel joins any stop already in flight and answers `204` however often it is repeated. `delegation.ts` relays each child's events as a `forkScoped` fiber of the caller's scope; `remote-tools.ts` connects each MCP client in a child scope whose close is registered before the connect, so a bounded or interrupted connect still releases the transport, and a failed call is `McpRequestFailed`. `server.ts` and `main.ts` are the only files that call a runner.

## Long-poll

`RuntimeDriver.poll(execution, after, { waitMs })` and the optional `longPoll` flag are the contract. A driver that declares `longPoll` honors `waitMs`: it returns at once with events after the cursor or a terminal outcome, otherwise after `waitMs`. `PromiseRuntimeDriver.poll(execution, after, signal, options)` receives the same options, and `fromPromiseDriver` forwards the flag. The Container driver passes `wait=` (at most 25 s) to the supervisor's `GET /jobs/:turn?after=&wait=`, where `JobLog.poll` waits on `Wake`; a missing execution and terminal outcomes never wait. The reconciler asks each poll to wait for the rest of its alarm interval and keeps polling within it while events keep arriving, so streaming latency follows the runtime rather than the alarm. `pollIntervalMs` therefore defaults to 5 seconds, and the alarm's cost is one wake-up per interval while a turn is quiet.

## What is deliberately not Effect

- Transaction callbacks and the state machine (`session-state.ts`, `session-events.ts`, `SqlStore`): synchronous by type, because `transactionSync` is the platform's atomicity and an Effect there would either lie or suspend.
- Wire schemas (`protocol.ts`, `agent-tools.ts`, `environment-config.ts`, `workspace.ts`, `programmatic-contract.ts`): zod, because the OpenAI, MCP, Claude and OpenCode SDKs consume zod. Effect Schema is used for internal contracts (`runtime.ts`) and the RPC envelope, bridged with `Schema.declare` where a zod type crosses. `parse` throws `InvalidRequest` at a synchronous boundary; `parseEffect` keeps it in the error channel.
- Native SDK callbacks (`canUseTool`, MCP tool handlers, OpenCode plugin tools): Promise-shaped by the SDKs; they enter fibers through `perform`.
- Hono route handlers (`http/*.ts`) and the supervisor's routes: `async`/`await` glue that runs one program at its boundary.
- In-sandbox scripts and CPU-bound parsers (`sandbox-tools.ts`, `opencode-tools.ts`, `skill-zip.ts`, `capability-archive.ts`, `portable-capabilities.ts`, `models/input.ts`, `models/output.ts`): no lifecycle, no concurrency, nothing to gain.
- `bearerTenant`: WebCrypto.

The example Worker bundle is 5,146 KiB (946 KiB gzip) as `wrangler deploy --dry-run` reports it, up from 4,631 KiB (849 KiB gzip) before `Stream`, `Schedule` and `PubSub` were pulled in.

## Reading the pinned release

The pinned Effect release ships no `AGENTS.md`. Read `node_modules/effect/src` for signatures and the Effect v3 documentation for semantics before writing Effect code, and preserve the pin. `pnpm typecheck` includes the Effect language-service diagnostics through `@effect/tsgo`; `pnpm effect:diagnostics` runs them alone.
