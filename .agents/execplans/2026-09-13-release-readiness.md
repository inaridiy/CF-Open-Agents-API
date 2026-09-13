# Release readiness

## Goal and completion criteria

Fix the three verified library defects and the publication review. Preserve the
Effect 3.22.2 development pin, Sandbox preview/image pairing, native agent loops,
and existing user changes. Commit the integrated implementation, pass CI, and
create v0.1.0. Prepare a manual npm publish workflow; do not publish the package or
change repository visibility. Enable private vulnerability reporting only after
the user explicitly requests it following publication of the repository.

## Current state and evidence

Baseline is 05f84e4 plus the uncommitted Effect rewrite. Review reproduced a
cancel/tool-result queue stall, reservation JSON growing beyond the documented
SQLite row limit, and idempotent creation failing after saved-agent deletion.
Baseline check, Codex, and native harness suites passed. Local Container builds
are constrained by available disk space; remote CI must exercise that boundary.
The removed temporary review test was deliberately moved by the reviewer.

## Decisions and open questions

Retain the stored JSON layout and add a conservative UTF-8 row budget before SQL
writes. Reject oversized requests with a structured 413. Look up existing
reservations before resolving mutable agent/model dependencies. After dispatching
cancel, recover the native terminal outcome before attempting later commands.
Replace proposal/process documents with concise English descriptions of current
architecture and validation. Remove personal skill snapshots and use repository-owned guidance and checks.
Retain public upstream skills with their license texts and attribution.
Both example model IDs are present in current official provider documentation.

## Progress

- [x] Verify review findings, versions, repository visibility and model IDs.
- [x] Repair behavior and add durable regressions.
- [x] Prepare documentation, licenses, package metadata and release automation.
- [ ] Run local checks, packed consumer validation and hosted CI.
- [ ] Commit, push, create v0.1.0 after CI, and report remaining operator steps.

## Validation so far

`pnpm check`: passed, including 23 Worker regressions and 3 checker fixtures.
`pnpm test:codex`: 1 passed. `pnpm test:harnesses`: 18 passed.
`pnpm types` and `pnpm peers check`: passed. `pnpm test:package`: passed in a
separate consumer, including license inventory, runtime imports and one shared
Effect installation. Local Container/deployment rebuilds are deferred to hosted
CI because the development volume cannot hold another image build.

Personal skill snapshots and all references were removed as requested. Repository
checks and contributor guidance are now self-contained. Git history is unchanged.
The maintainer will request private vulnerability reporting activation after
making the repository public; no visibility or reporting setting was changed.
