# create-cf-open-agents-api

## 0.6.1

### Patch Changes

- [#24](https://github.com/inaridiy/CF-Open-Agents-API/pull/24) [`0b618a0`](https://github.com/inaridiy/CF-Open-Agents-API/commit/0b618a0498ad7d9f48ebacae919071abe2ab9d26) Thanks [@inaridiy](https://github.com/inaridiy)! - Fix the upgrade from 0.5: a Durable Object class whose namespace has had a default-policy container application does not start `durable_object` containers, and the old applications have to go as part of the switch. "Upgrading from 0.5" in docs/deployment.md now binds `HARNESS` and `SANDBOX` to new classes (`HarnessContainerDO`, `SandboxContainerDO`) and deletes the old applications. `create-cf-open-agents-api init` and `doctor` accept those class names; `init --force` no longer rewrites a default-policy container entry in place, which produced a configuration whose containers never started. `SandboxDO` now fails a container start that has not become ready within 3 minutes instead of waiting indefinitely.

## 0.6.0

### Minor Changes

- [#21](https://github.com/inaridiy/CF-Open-Agents-API/pull/21) [`4fecd31`](https://github.com/inaridiy/CF-Open-Agents-API/commit/4fecd315cabd0e8a6350a5a464b4d0e0e5dc1b93) Thanks [@inaridiy](https://github.com/inaridiy)! - Move the container objects to Cloudflare's Durable Object Container API and `@cloudflare/sandbox` 1.0, and run their lifecycles on the new `durable-machine` package.

  `HarnessDO` and `SandboxDO` now start their own containers (`scheduling_policy: "durable_object"`, named `images`, a new container application `name` each); the instance size is chosen in code (`standard-1` by default, `defineAgentWorker({ instances })`). Each object's lifecycle is a durable state machine: it boots its container on first use, destroys it from its own alarm after ten idle minutes, destroys it on every way out of the running state, and after a session's deletion never starts one again (`ContainerRetired`). Harness egress goes through `ContainerEgress`, a restricted sandbox's through `SandboxEgress`, and workspace backups through `DirectoryBackup` and the `BACKUP_BUCKET` binding, so the R2 API token secrets, `BACKUP_BUCKET_NAME` and `LOCAL_BACKUPS` are gone; backups written by 0.x restore once and are rewritten in the 1.0 format.

  Breaking: the Worker's main module exports `ContainerEgress`, `SandboxEgress` and `DirectoryBackupGateway` in place of `ContainerProxy`; `createHarness` hooks receive a `Workspace`; `BackupCredentialsMissing` is removed. Moving an existing deployment to the new scheduling policy cannot be undone; see "Upgrading from 0.5" in docs/deployment.md. `create-cf-open-agents-api init` notes legacy container entries and `init --force` rewrites them.

  The lifecycles run on `durable-machine`, a new workspace package of typed state machines for Durable Objects (transitions inside one SQLite transaction, exhaustive event tables, release-on-exit resources, timers on the object's alarm, a fenced outbox run by Effect, a model-based checker). It is not published yet; the library ships a copy in `dist/vendor/`.

  Hardening from a security review: a restricted sandbox's egress no longer follows redirects for it (each hop is checked), cancelled or oversized sandbox commands now end their whole process group, file operations, backups and transfers have deadlines, overlapping subagent spawns can no longer exceed the concurrency limit or drop children from cleanup, assignment updates no longer overwrite a revocation, and a native checkpoint larger than 64 MiB fails with `CheckpointTooLarge` instead of exhausting the Worker's memory.

## 0.5.1

No changes in this release.

## 0.5.0

No changes in this release.

## 0.4.2

No changes in this release.

## 0.4.1

### Patch Changes

- [#8](https://github.com/inaridiy/CF-Open-Agents-API/pull/8) [`0b0809c`](https://github.com/inaridiy/CF-Open-Agents-API/commit/0b0809c8e1123062d12620d173c56a2d1e662af2) Thanks [@inaridiy](https://github.com/inaridiy)! - Releases are driven by changesets: a pull request adds a `.changeset` entry, the publish workflow opens a "Version Packages" pull request after the merge, and merging that publishes both npm packages, pushes the `v<version>` tag the setup CLI's `vendor` step downloads, and the per-package tags. The changelog moved from the repository root to `packages/agent-api/CHANGELOG.md` and `packages/create-cf-open-agents-api/CHANGELOG.md`, which the packages now ship as their own files.
