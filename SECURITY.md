# Security policy

## Reporting a vulnerability

Do not post exploit details, credentials or tenant data in public issues.

When the repository is published, GitHub Private Vulnerability Reporting will be enabled as part of the [release procedure](docs/releasing.md), and reports go through [Report a vulnerability](https://github.com/inaridiy/CF-Open-Agents-API/security/advisories/new). Until that switch is flipped, contact the repository owner through a private channel; the release checklist verifies the reporting link before the first npm publication.

Include the affected version or commit, configuration, a minimal reproduction, impact, and redacted logs. Allow the maintainer to investigate and coordinate a fix before publishing technical details.

## Supported versions

The `main` branch and the latest `0.x` tag are the supported line. Earlier snapshots are not maintained separately. There is no response-time SLA before `1.0`.

## Security boundaries

Models and workspace code are untrusted. Model credentials stay in the private gateway Worker. Deployment code controls presets, container images, tool registrations and provisioning. The harness container has no Internet access; the sandbox container has the network policy the environment configured. Service Binding callers are trusted to authenticate users and supply tenant IDs; HTTP callers are authenticated by the deployment's `authenticate` function.

Operators must configure authentication, resource budgets, permitted tool effects, network access and R2 retention for their deployment. Container isolation does not make external tools safe or undo their effects. A completed checkpoint records native history and files, not transactional completion of external operations.

### Sandbox reuse

A session's sandbox is kept alive between turns while it holds the last committed workspace. State outside `/workspace`, including packages installed and files written by setup commands or by the agent, persists across those turns. It is discarded when the sandbox is restored after a cancel, a failure, a container loss or a fork. Treat everything a setup command or the model writes as visible to every later turn of that session, and do not place secrets in the sandbox: environment variables and MCP credentials for service-origin servers stay in the Worker, and environment-origin MCP servers cannot use Vault credentials for that reason.

### What to report

Tenant isolation failures, credential exposure (model, Vault or R2), unauthorized gateway or tool access, checkpoint or artifact path traversal, sandbox or harness container escapes, and any way for workspace content to alter Worker bindings or deployment policy. Bugs in upstream runtimes or Cloudflare components may need coordinated upstream fixes. See [deployment](docs/deployment.md) and [compatibility](docs/compatibility.md) for the supported configuration and limits.
