---
"cf-open-agents-api": minor
"create-cf-open-agents-api": minor
---

Move the container objects to Cloudflare's Durable Object Container API and `@cloudflare/sandbox` 1.0, and run their lifecycles on the new `durable-machine` package.

`HarnessDO` and `SandboxDO` now start their own containers (`scheduling_policy: "durable_object"`, named `images`, a new container application `name` each); the instance size is chosen in code (`standard-1` by default, `defineAgentWorker({ instances })`). Each object's lifecycle is a durable state machine: it boots its container on first use, destroys it from its own alarm after ten idle minutes, destroys it on every way out of the running state, and after a session's deletion never starts one again (`ContainerRetired`). Harness egress goes through `ContainerEgress`, a restricted sandbox's through `SandboxEgress`, and workspace backups through `DirectoryBackup` and the `BACKUP_BUCKET` binding, so the R2 API token secrets, `BACKUP_BUCKET_NAME` and `LOCAL_BACKUPS` are gone; backups written by 0.x restore once and are rewritten in the 1.0 format.

Breaking: the Worker's main module exports `ContainerEgress`, `SandboxEgress` and `DirectoryBackupGateway` in place of `ContainerProxy`; `createHarness` hooks receive a `Workspace`; `BackupCredentialsMissing` is removed. Moving an existing deployment to the new scheduling policy cannot be undone; see "Upgrading from 0.5" in docs/deployment.md. `create-cf-open-agents-api init` notes legacy container entries and `init --force` rewrites them.

The lifecycles run on `durable-machine`, a new workspace package of typed state machines for Durable Objects (transitions inside one SQLite transaction, exhaustive event tables, release-on-exit resources, timers on the object's alarm, a fenced outbox run by Effect, a model-based checker). It is not published yet; the library ships a copy in `dist/vendor/`.

Hardening from a security review: a restricted sandbox's egress no longer follows redirects for it (each hop is checked), cancelled or oversized sandbox commands now end their whole process group, file operations, backups and transfers have deadlines, overlapping subagent spawns can no longer exceed the concurrency limit or drop children from cleanup, assignment updates no longer overwrite a revocation, and a native checkpoint larger than 64 MiB fails with `CheckpointTooLarge` instead of exhausting the Worker's memory.
