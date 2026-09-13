# Security policy

## Reporting a vulnerability

Do not post exploit details, credentials or tenant data in public issues.
After this repository becomes public, the maintainer will enable GitHub Private
Vulnerability Reporting. Reports can then be submitted through
[Report a vulnerability](https://github.com/inaridiy/CF-Open-Agents-API/security/advisories/new).
That reporting channel is not enabled while the repository remains private;
existing collaborators should contact the repository owner through their existing
private channel. The [release procedure](docs/releasing.md) includes enabling and
verifying private reporting when the repository is made public.

Include the affected version/commit, configuration, minimal reproduction, impact,
and relevant redacted logs. Allow the maintainer to investigate and coordinate a
fix before publishing technical details.

## Supported versions

The latest 0.1.x alpha is the supported development line. Earlier snapshots are
not maintained separately. This experimental release has no response-time SLA.

## Security boundaries

Models and workspace code are untrusted. Model credentials stay in the private
Worker gateway. Deployment code controls model aliases, Container images, tool
registrations and provisioning. Harness and Sandbox Containers are separate;
Service Binding callers are trusted to authenticate users and supply tenant IDs.

Operators must configure authentication, resource budgets, permitted tool effects,
network access and R2 retention for their deployment. Container isolation does not
make external tools safe or undo their effects. A completed checkpoint records
native history and files, not transactional completion of external operations.

Report tenant isolation failures, credential exposure, unauthorized gateway/tool
access, checkpoint path traversal and execution-boundary escapes. Bugs in upstream
runtimes or Cloudflare components may require coordinated upstream fixes. See
[deployment](docs/deployment.md) and [compatibility](docs/compatibility.md) for the
supported configuration and limits.
