# Releasing

Releases are driven by [changesets](https://github.com/changesets/changesets). A pull request that changes what a release ships adds a file under `.changeset/` (`pnpm changeset`); the publish workflow turns pending changesets into a "Version packages" pull request, and merging that pull request publishes the npm packages and pushes the tags. Nobody bumps a version or pushes a tag by hand. `v0.1.0` was tagged but never released to npm; `v0.2.0` was the first published alpha; `v0.4.0` was the last release made by hand.

## Versions and changelogs

The four packages share one version: `.changeset/config.json` lists `cf-open-agents-api`, `create-cf-open-agents-api` and the private `cf-open-agents-api-supervisor` and `durable-machine` as a `fixed` group, so a changeset for any of them bumps all four, and `pnpm check:docs` verifies that the library and the CLI agree. The examples are ignored. Pre-release versions stay under `0.x` and publish under the npm `alpha` dist-tag, never `latest`; the release script passes `--tag alpha` explicitly, because `changeset publish` picks `latest` on its own and ignores `publishConfig.tag`.

`changeset version` writes each package's changelog, `packages/agent-api/CHANGELOG.md`, `packages/create-cf-open-agents-api/CHANGELOG.md` and `packages/durable-machine/CHANGELOG.md`, with `@changesets/changelog-github`, which links the pull request and its author; the root `CHANGELOG.md` only points at them. The library's file also holds the history before 0.4.1, when one changelog covered both packages. Write a changeset summary the way a changelog reader needs it: what changed for a user of the package, in one or two sentences.

## The publish workflow

`publish.yml` runs after every successful CI run on `main` (`workflow_run`), in the `npm` environment, and first checks that the commit is on `main`, that the repository is public and that private vulnerability reporting is enabled. It installs, builds, runs `pnpm test:package`, and then hands over to `changesets/action`:

- With pending changesets, the action runs `pnpm changeset version` and opens or updates the **Version packages** pull request (branch `changeset-release/main`), which carries the version bumps and the changelog entries. Review it and merge it; nothing is published yet. The pull request is opened with the workflow's own token, so GitHub does not run CI on it; the merge commit on `main` is what CI verifies before anything publishes.
- With no pending changesets and a version that is not yet on npm, the action runs `pnpm release` (`scripts/release.mjs`): it creates the annotated `v<version>` tag and the per-package tags (`changeset git-tag`), pushes them, and only then runs `changeset publish --no-git-tag --tag alpha`, which publishes the library and the CLI with npm trusted publishing (OIDC, `--provenance` from `publishConfig`). The tags go first because a generated project's `vendor` step downloads the `v<version>` archive of this repository, so the tag must exist before the CLI is installable. A version already on npm is skipped, so a rerun after a partial failure publishes what is missing and moves no tag.

`workflow_dispatch` reruns the same job for the current `main`, for a publish that failed halfway. Never move a published tag. The workflow needs the repository setting "Allow GitHub Actions to create and approve pull requests" and the npm trusted publisher configured for `publish.yml` in the `npm` environment; no registry token is stored anywhere.

## After a release

Inspect the tarball and the npm version metadata (`npm view cf-open-agents-api@<version>`, `npm view create-cf-open-agents-api@<version>`, both under the `alpha` dist-tag), install the package in a clean consumer, and link the tag and changelog in any announcement. Publication and announcements are maintainer actions, separate from review.

## `durable-machine`

`durable-machine` is private until it has settled: `changeset publish` skips it, and the library carries its own copy instead of depending on it. `packages/agent-api/scripts/inline-machine.mjs`, run by the library's build, copies the built package to `dist/vendor/durable-machine/` and points the compiled imports at it; `pnpm test:package` checks that the tarball contains it and does not depend on it.

To publish it later: drop `"private": true`, add `publishConfig` like the library's, make it a dependency of the library again in place of the inline step, and remember that npm trusted publishing is configured per package, so the workflow cannot publish its first version. The owner publishes it once by hand (or creates it on npm), then adds a trusted publisher for it (this repository, workflow `publish.yml`, environment `npm`, with publishing allowed).

## Before the first public release

Done on 2026-09-18 for `v0.2.0`; kept as the record of what the workflow relies on.

1. Make the repository public. Enable GitHub Private Vulnerability Reporting at the same time, check that the [report link](https://github.com/inaridiy/CF-Open-Agents-API/security/advisories/new) works, and update SECURITY.md to say so.
2. Configure the `npm` GitHub environment and its release permissions. Configure npm trusted publishing for this repository, workflow `publish.yml`, environment `npm`. Initial package registration may need an owner-operated bootstrap; never add registry credentials to the repository. See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).
3. Verify package name ownership, README, the changelogs, LICENSE and NOTICE.

## Dependency policy

Renovate opens updates on Monday mornings (Asia/Tokyo) and only for releases that are at least 24 hours old (`minimumReleaseAge`). The native runtime pins (`@openai/codex`, `@anthropic-ai/claude-agent-sdk`, `opencode-ai`, `@opencode-ai/sdk`) are excluded because they define resumable state formats; bump them by hand together with `docker/`, `packages/agent-api/src/harnesses.ts` and the compatibility profile. `@cloudflare/sandbox` is excluded too: it defines the workspace backup record that checkpoints store, and the `sandbox-shim` tag in `docker/Sandbox.Dockerfile` must move with it. To take a release that is younger than 24 hours, wait, or open the bump manually and say why in the pull request.
