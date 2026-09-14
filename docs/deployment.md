# Deployment and verification

The example is one Worker owning all DO classes, two Container images, two R2
buckets, and a private loopback `Models` Service Binding. `HarnessDO` uses `basic`
(1 GiB) and `SandboxDO` uses `standard-1` (4 GiB); tune these after measurement.
The Sandbox package and image both pin `0.13.0-next.751.1`.

Run `pnpm deploy:check` to validate both the Agent Worker and caller bundles, and
build the Container images without publishing them. Run `pnpm types` after changing Wrangler bindings. Deploying is a
separate operator action; no remote deployment is part of the local tests.

## Production configuration

Create the `cf-open-agents-api-checkpoints` and `cf-open-agents-api-workspaces` R2 buckets, or change
the example configuration to your bucket names. Set secrets through Wrangler:

- `API_TOKEN`: at least 32 unpredictable characters for the example HTTP auth.
- `OPENAI_API_KEY`: model key used only by the private model gateway.
- `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`: scoped to the workspace backup bucket.
- `CLOUDFLARE_R2_ACCOUNT_ID`: account used for R2 presigned URLs.

`BACKUP_BUCKET_NAME` is a non-secret Wrangler variable. Leave `LOCAL_BACKUPS`
unset in production. The Sandbox SDK's backup code creates scoped presigned URLs;
the sandbox does not receive permanent R2 or model credentials.

Replace the example's single-tenant authenticator for a multi-tenant deployment.
Only trusted Workers should hold a Service Binding to this API. Set account-level
rate limits and usage budgets appropriate to your deployment before public access.
The library's turn deadline and instance cap do not constitute a billing budget.
The example disables `workers.dev` and preview URLs; a Service Binding works without
an Internet-facing route. Add a route deliberately when hosting the HTTP API.

The `coding` preset uses Codex with native Responses passthrough so images, native
reasoning, web search and structured-output settings reach the configured provider.
The private gateway enforces the session's search mode: `disabled` removes the
search tool, `cached` disables external web access, and `live` enables it. This
also corrects Codex 0.154.0 promoting cached search under full-access execution.
Other presets use
the portable AI SDK adapter; see [model protocols](extending.md#model-protocols).

The `environments: containerEnvironments` option enables configured environments.
The checkpoints bucket also stores private environment configuration, input files
and immutable artifacts. Vault secrets are stored in the tenant's Catalog DO;
service-origin MCP requests obtain credentials through that private boundary.
Model-provider credentials remain in the model gateway. Environment MCP commands
and package/setup commands execute in the Sandbox with its configured network policy.

## Checkpoint operations

Native snapshots use immutable per-session/per-generation keys. A successful turn
commits native and workspace references only after both exist. Failed uploads can
leave orphan objects. Physical deletion and retention are operator responsibilities
in this alpha; session deletion removes public discovery, not every R2 object.

Workspace snapshots capture files; detached processes cannot be resumed. Snapshot
at an application quiescent boundary. The backup SDK does not make filesystem and
external-service writes transactional. Do not use a checkpoint as evidence that an
external deployment or payment happened exactly once.

## Local runtime notes

`pnpm test` exercises the actual production composition factory in workerd using
SQLite DOs and a deliberately scripted runtime driver. `pnpm test:codex` exercises
native Codex with an isolated home and a local scripted Responses server. It never
uses the operator's Codex login or a real provider key.
`pnpm test:harnesses` additionally exercises Claude Code and OpenCode, native history
restoration, and instantiated AI SDK model connections through official SDK clients.

Run the complete local smoke with:

```sh
pnpm test:containers
```

It uses a fresh persistence directory and a scripted local model. For each of the
three harnesses it verifies native shell execution, Claude/OpenCode
write/edit/read replacements, a configured environment with a pinned saved skill,
an inline plugin, a service-origin MCP server with a Vault credential, immutable
artifacts, isolation from the harness filesystem, a second turn after both
Containers are destroyed, programmatic tool calling with parallel client calls,
explicit cancellation, an abandoned workspace call ending as
`programmatic_execution_uncertain`, a same-harness fork that recovers the
committed workspace, a delegated subagent on the next runtime sharing that
workspace, and a cross-runtime fork continuing with the inherited workspace and
transcript. The Codex fixture also exercises Files API uploads, environment file
listings, image input, cached search configuration at model egress, reported
usage and an `environment: none` session. It cleans up the Containers it created.
Logs and local R2/SQLite evidence remain in the printed temporary directory.
`CF_SMOKE_HARNESSES=opencode` narrows the run to one runtime while diagnosing.
When a native execution stops, the Worker logs a bounded tail of the supervisor's
native stderr as `Native harness diagnostics`; the same tail explains a
`native_harness_failed` turn in production logs.
No Cloudflare deployment, provider secret, or paid inference is involved.

Cloudflare's local Container proxy needs a route back to workerd. Rootless Docker
with `--detach-netns` can place the actual Docker bridge in a different namespace
from both the host and `docker run --network host`. In that configuration, run the
smoke in rootlesskit's network namespace. On Linux with the standard user service:

```sh
# These variables describe this task; they do not change the Docker daemon.
cf_open_agents_rootless="${XDG_RUNTIME_DIR}/dockerd-rootless"
cf_open_agents_pid="$(cat "$cf_open_agents_rootless/child_pid")"
cf_open_agents_dns="$(mktemp)"
printf 'nameserver 10.0.2.3\n' > "$cf_open_agents_dns"
nsenter --user="/proc/$cf_open_agents_pid/ns/user" \
  --net="/proc/$cf_open_agents_pid/root$cf_open_agents_rootless/netns" \
  --preserve-credentials unshare --mount bash -c \
  'mount --make-rprivate / && mount --bind "$1" /etc/resolv.conf && pnpm test:containers' \
  cf-open-agents-api-smoke "$cf_open_agents_dns"
rm "$cf_open_agents_dns"
```

The DNS address above is slirp4netns's default; use your rootlesskit resolver if it
was customized. The bind mount is private to the test process. No host routes,
Docker daemon configuration, or system resolver are changed. Ordinary rootful Docker
does not need this workaround.

See [known development issues](known-issues.md) for narrowly scoped upstream warnings.
