# Changesets

A pull request that changes what a release ships adds a file here: `pnpm changeset` asks which packages change and how (the three packages share one version, so pick any of them and the bump applies to all), then a summary written for the changelog. Docs-only and test-only changes need none.

After a merge to `main`, the publish workflow turns the pending files into a "Version Packages" pull request; merging that one publishes to npm and pushes the tags. See [releasing](../docs/releasing.md).
