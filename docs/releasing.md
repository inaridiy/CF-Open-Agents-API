# Releasing

A release is a version tag on a commit whose CI run passed. The npm package is built from that tag. Pushing commits or tags publishes nothing: `publish.yml` runs only by manual workflow dispatch. Nothing has been published yet; `v0.1.0` was tagged but not released to npm.

## Before the first public release

1. Make the repository public. Enable GitHub Private Vulnerability Reporting at the same time, check that the [report link](https://github.com/inaridiy/CF-Open-Agents-API/security/advisories/new) works, and update SECURITY.md to say so.
2. Configure the `npm` GitHub environment and its release permissions. Configure npm trusted publishing for this repository, workflow `publish.yml`, environment `npm`. Initial package registration may need an owner-operated bootstrap; never add registry credentials to the repository. See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).
3. Verify package name ownership, README, CHANGELOG.md, LICENSE and NOTICE. Pre-release versions publish under the `alpha` dist-tag and must not replace `latest`.

## Version and validate

1. Bump `version` in `packages/agent-api/package.json` and `packages/supervisor/package.json` together, and turn the `Unreleased` changelog heading into the version and date.
2. Install with the pinned pnpm and run the applicable rows of the [validation table](../CONTRIBUTING.md#validation), including `pnpm test:package`.
3. Commit, push, and wait for CI. CI runs `pnpm check`, `pnpm test:codex`, `pnpm test:package`, `pnpm test:harnesses`, `pnpm test:containers` and `pnpm deploy:check`.
4. After CI passes, create and push an annotated tag matching the package version, such as `v0.2.0`. Never move a published tag.

## Publish

Run **Publish npm alpha** with the tag as input. The workflow checks that the tag matches the package version, that the tagged commit passed CI on a push, that the repository is public and that private vulnerability reporting is enabled. It then runs the checks again, packs the package, and publishes with provenance through npm OIDC. No long-lived token is needed once trusted publishing is configured.

Inspect the tarball and the npm version metadata, install the package in a clean consumer, and link the tag and changelog in any announcement. Publication and announcements are maintainer actions, separate from review.

## Dependency policy

Renovate opens updates on Monday mornings (Asia/Tokyo) and only for releases that are at least 24 hours old (`minimumReleaseAge`). The native runtime pins (`@openai/codex`, `@anthropic-ai/claude-agent-sdk`, `opencode-ai`, `@opencode-ai/sdk`) and `@cloudflare/sandbox` are excluded because they define resumable state formats and image pairs; bump them by hand together with `docker/`, `packages/agent-api/src/harnesses.ts` and the compatibility profile. To take a release that is younger than 24 hours, wait, or open the bump manually and say why in the pull request.
