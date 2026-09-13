# Releasing an alpha

The source of a release is a version tag pointing at a committed revision whose
CI run passed. The npm package is built from that tag. Pushing commits or tags
does not publish a package: `publish.yml` runs only by manual workflow dispatch.

## Before the first public release

1. Make the repository public when the maintainer is ready. Enable GitHub Private
   Vulnerability Reporting at that time, verify the reporting link, and update
   SECURITY.md to state that it is enabled. This setting is intentionally deferred
   while the repository is private.
2. Configure the `npm` GitHub environment and its release permissions. Configure
   npm trusted publishing for this repository, workflow `publish.yml`, environment
   `npm`, allowing direct publication. Initial package registration or npm account
   authentication may require an owner-operated bootstrap; do not add registry
   credentials to the repository. See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).
3. Verify package name ownership, README, CHANGELOG.md, LICENSE and NOTICE. The
   release uses the `alpha` dist-tag; it must not replace `latest` during this alpha.

## Version and validate

Update the public package and supervisor versions and the changelog together.
Install with the pinned pnpm and run the applicable
[validation matrix](../CONTRIBUTING.md#validation), including `pnpm test:package`.
Commit the complete change, push it, and wait for the CI workflow. CI covers the
native runtimes, Container/R2 restore, package consumer and deployment dry run.

After CI passes, create and push an annotated tag matching the public package
version, such as `v0.1.0`. Do not move a published tag. If validation fails, fix and
validate the change before creating the release tag.

## Publish

Manually run **Publish npm alpha** with the version tag as its input. The workflow
checks that the tag matches the package version, the tagged commit has passed CI,
the repository is public, and private vulnerability reporting is enabled. It then
checks and packs the package, and publishes it with provenance through npm OIDC.
No long-lived publishing token is required after trusted publishing is configured.

Inspect the resulting tarball and npm version metadata, install the package in a
clean consumer, and link the tag and changelog in any release announcement.
Publication and announcements are maintainer actions, separate from source review.
