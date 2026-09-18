# Releasing

A release is a version tag on a commit whose CI run passed. The npm package is built from that tag. Pushing commits or tags publishes nothing: `publish.yml` runs only by manual workflow dispatch. `v0.1.0` was tagged but never released to npm; `v0.2.0` is the first published alpha.

## Before the first public release

Done on 2026-09-18 for `v0.2.0`; kept as the record of what the publish workflow checks.

1. Make the repository public. Enable GitHub Private Vulnerability Reporting at the same time, check that the [report link](https://github.com/inaridiy/CF-Open-Agents-API/security/advisories/new) works, and update SECURITY.md to say so.
2. Configure the `npm` GitHub environment and its release permissions. Configure npm trusted publishing for this repository, workflow `publish.yml`, environment `npm`. Initial package registration may need an owner-operated bootstrap; never add registry credentials to the repository. See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).
3. Verify package name ownership, README, CHANGELOG.md, LICENSE and NOTICE. Pre-release versions publish under the `alpha` dist-tag and must not replace `latest`.

## Version and validate

1. Bump `version` in `packages/agent-api/package.json`, `packages/supervisor/package.json` and `packages/create-cf-open-agents-api/package.json` together (`pnpm check:docs` verifies the first and last agree), and turn the `Unreleased` changelog heading into the version and date.
2. Install with the pinned pnpm and run the applicable rows of the [validation table](../CONTRIBUTING.md#validation), including `pnpm test:package`.
3. Commit, push, and wait for CI. CI runs `pnpm check`, `pnpm test:codex`, `pnpm test:package`, `pnpm test:harnesses`, `pnpm test:containers` and `pnpm deploy:check`.
4. After CI passes, create and push an annotated tag matching the package version, such as `v0.2.0`. Never move a published tag.

## Publish

Run **Publish npm alpha** with the tag as input. The workflow checks that the tag matches both package versions, that the tagged commit passed CI on a push, that the repository is public and that private vulnerability reporting is enabled. It then runs the checks again, packs both packages, and publishes them with provenance through npm OIDC: the library first, then `create-cf-open-agents-api`. The order matters because a generated project depends on the library at the same version, and the CLI's `vendor` step downloads the archive of the tag it was built from, so the tag must be pushed before the CLI is published. No long-lived token is needed once trusted publishing is configured.

Inspect the tarball and the npm version metadata, install the package in a clean consumer, and link the tag and changelog in any announcement. Publication and announcements are maintainer actions, separate from review.

## Dependency policy

Renovate opens updates on Monday mornings (Asia/Tokyo) and only for releases that are at least 24 hours old (`minimumReleaseAge`). The native runtime pins (`@openai/codex`, `@anthropic-ai/claude-agent-sdk`, `opencode-ai`, `@opencode-ai/sdk`) and `@cloudflare/sandbox` are excluded because they define resumable state formats and image pairs; bump them by hand together with `docker/`, `packages/agent-api/src/harnesses.ts` and the compatibility profile. To take a release that is younger than 24 hours, wait, or open the bump manually and say why in the pull request.
