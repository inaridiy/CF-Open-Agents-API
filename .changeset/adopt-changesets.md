---
"cf-open-agents-api": patch
"create-cf-open-agents-api": patch
"cf-open-agents-api-supervisor": patch
---

Releases are driven by changesets: a pull request adds a `.changeset` entry, the publish workflow opens a "Version Packages" pull request after the merge, and merging that publishes both npm packages, pushes the `v<version>` tag the setup CLI's `vendor` step downloads, and the per-package tags. The changelog moved from the repository root to `packages/agent-api/CHANGELOG.md` and `packages/create-cf-open-agents-api/CHANGELOG.md`, which the packages now ship as their own files.
