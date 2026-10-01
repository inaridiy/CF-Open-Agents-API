# Deployment and verification

The example in `examples/worker` is one Worker that exports every class: `Agents` (the API, also the default export), `SessionDO`, `TenantCatalogDO`, `HarnessDO`, `SandboxDO`, and the `Models`, `ContainerEgress`, `SandboxEgress` and `DirectoryBackupGateway` entrypoints. The container objects look the last three up in `ctx.exports` by these names, so the main module exports them unrenamed; a missing one fails with `503 container_misconfigured`. The Worker binds two containers, two R2 buckets, a loopback Service Binding to `Models`, a `CODE_LOADER` worker loader and the `AI` binding.

`HarnessDO` and `SandboxDO` are Durable Objects that start their own containers (`scheduling_policy: "durable_object"`). Each Wrangler `containers` entry names its class, a container application of its own (`<worker>-harness`, `<worker>-sandbox`) and one named image (`images.harness`, `images.sandbox`) with its Dockerfile and build context; it has no `image`, `instance_type` or `max_instances`. The instance size is chosen in code: both request `standard-1` (1/2 vCPU, 4 GiB) by default, and `defineAgentWorker({ instances: { harness, sandbox } })` takes any size `ctx.container.start()` accepts (`lite`, `standard-1` to `standard-4`, or custom resources; not `basic`). Tune both after measurement. `@cloudflare/sandbox` is pinned to `1.0.0` and used only for `DirectoryBackup`.

Running any harness needs this repository's Docker images: `docker/Harness.Dockerfile` (the supervisor, Codex and OpenCode on Node 24) and `docker/Sandbox.Dockerfile` (Node 24 on Debian bookworm with bash, git, Python 3, pip, Codex for its `exec-server`, `unsquashfs` for 0.x backups, and the `sandbox-shim` binary copied from the `cloudflare/sandbox` image whose tag equals the `@cloudflare/sandbox` version). Wrangler builds them from `examples/worker/wrangler.jsonc` (and from `examples/demo/wrangler.jsonc`, the demo app with the same composition); a project set up by the [CLI](../packages/create-cf-open-agents-api/README.md) builds the same Dockerfiles from its `.cf-open-agents-api/` snapshot.

## Production walkthrough with the CLI

In a project the CLI set up, provisioning is two commands; `doctor` checks the toolchain, the binding agreement rules and the local token first:

```sh
pnpm dlx create-cf-open-agents-api@alpha doctor
pnpm dlx create-cf-open-agents-api@alpha setup     # wrangler r2 bucket create ×2, wrangler secret bulk with the secrets
pnpm exec wrangler deploy
```

`setup` prompts for the values (or reads them from the environment with `--from-env`). The manual steps below are what it runs.

## Production walkthrough by hand

1. Create the R2 buckets, or rename them in `examples/worker/wrangler.jsonc`:

   ```sh
   pnpm exec wrangler r2 bucket create cf-open-agents-api-checkpoints
   pnpm exec wrangler r2 bucket create cf-open-agents-api-workspaces
   ```

2. Set the secrets. Each is read by exactly one component:

   | Secret           | Read by                                                                                                   |
   | ---------------- | --------------------------------------------------------------------------------------------------------- |
   | `API_TOKEN`      | The example authenticator `bearerTenant` in `examples/worker/src/index.ts`; at least 32 random characters |
   | `OPENAI_API_KEY` | The example model gateway (`nativeModel` and `aiSDKModel` presets); never leaves the Worker               |

   ```sh
   cd examples/worker
   for name in API_TOKEN OPENAI_API_KEY; do
     pnpm exec wrangler secret put "$name"
   done
   ```

   Workspace backups need no secret. `SandboxDO` writes and reads them through the `BACKUP_BUCKET` binding and the `DirectoryBackupGateway` entrypoint (`DirectoryBackup` from `@cloudflare/sandbox`): during one backup or restore the sandbox container holds a grant for that one object, and it never receives bucket or model credentials. A setup that fails inside the sandbox marks the session `environment_setup_failed`; the cause is in the Worker's logs as `Environment setup failed` with the session id.

3. Decide how the API is reached. The minimal template and `examples/worker` set `workers_dev: false` and `preview_urls: false`; a Service Binding works without any public route. The demo template publishes on workers.dev by default and its page has no login, so put Cloudflare Access in front of it or replace the page with your own auth before sharing the URL (`workers_dev: false` keeps it off workers.dev). Add a custom domain or route only if you host the HTTP API, and replace the single-tenant authenticator first.

4. Deploy:

   ```sh
   pnpm build
   pnpm deploy:check                                  # dry run of both Workers, builds both images
   pnpm exec wrangler deploy --config examples/worker/wrangler.jsonc
   pnpm exec wrangler deploy --config examples/caller/wrangler.jsonc   # optional
   ```

   The first deploy pushes both images to Cloudflare's registry and can take several minutes.

5. Verify:

   ```sh
   pnpm exec wrangler containers list
   pnpm exec wrangler containers images list
   ```

   Then create a session with `environment: { type: "openai_hosted" }` through the caller or your own client and retrieve `GET /v1/agents/environments/{id}`; `status: "connected"` proves that the sandbox container started and that the harness container can reach it. `pnpm exec wrangler tail --config examples/worker/wrangler.jsonc` shows `Native harness diagnostics` when a native execution stops, which is the first place to look when a turn fails with `native_harness_failed`.

## Upgrading from 0.5

Releases up to 0.5 ran `HarnessDO` and `SandboxDO` on the default scheduling policy through `@cloudflare/containers` and Sandbox SDK 0.x. This release moves both to `scheduling_policy: "durable_object"`, and that move cannot be undone: after the deploy, a rollback to a 0.5 version cannot start containers. Cloudflare's [plan the move](https://developers.cloudflare.com/sandbox/sdk/migrate/plan-the-move/) guide describes the platform side.

- The classes keep their names, so Durable Object storage and committed checkpoints carry over. The new container `name`s create new container applications; the old applications keep running, and billing for, the containers 0.5 started until you delete them: find them with `pnpm exec wrangler containers list` and remove each with `pnpm exec wrangler containers delete <id>`.
- A deployment that mixes versions cannot use gradual deployments; deploy the new version to 100%.
- Rehearse the upgrade on a staging Worker with sessions running in it before production. A staging deployment needs its own Worker and container application names in its configuration; `wrangler deploy --name` does not rename container applications.
- Turns in flight at the switch fail, and uncommitted workspace state in the old containers is lost. Committed checkpoints restore: a workspace backup that Sandbox SDK 0.x wrote is converted on its first restore, and the next checkpoint stores the 1.0 form.
- Afterwards, delete the secrets `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` and `CLOUDFLARE_R2_ACCOUNT_ID` (`pnpm exec wrangler secret delete <name>`) remove `vars.BACKUP_BUCKET_NAME` from the Wrangler configuration and `LOCAL_BACKUPS` from `.dev.vars`; nothing reads them.

In a project the CLI set up, run `create-cf-open-agents-api init` again: it notes each container entry still on the default policy, notes a leftover `BACKUP_BUCKET_NAME`, and replaces a class re-export in the entry module that still names `ContainerProxy`. `init --force` rewrites the container entries (and the composition module, which then exports `ContainerEgress`, `SandboxEgress` and `DirectoryBackupGateway`). A hand-written composition adds those three names to its `defineAgentWorker` destructuring and drops `ContainerProxy`.

## Presets and models

The example registers four presets: `codex`, `claude`, `opencode` and `workers` (the `codex` preset was named `coding` before 0.3.0; sessions pin the preset name they were created with). `codex` runs Codex through `nativeModel` with the Responses protocol, so images, native reasoning, hosted web search (`webSearch: true`) and structured output reach OpenAI unchanged. `claude` and `opencode` run the other runtimes through the portable AI SDK adapter against the same key on the `primary` registry entry; `claude` resolves its `haiku` subagent tier to the `fast` entry (`tiers`). `workers` runs Codex against Workers AI. The registry also holds `workersQwen`, a second Workers AI model no preset uses yet. `codex`, `claude` and `opencode` list each other as `delegates`. See [extending](extending.md) for the options.

The gateway enforces a session's search mode at model egress: `disabled` removes the search tool, `cached` disables external web access, `live` enables it. This also corrects Codex `0.154.0` promoting cached search to live under full-access execution.

## Scaling and cost

- No configuration caps the number of containers; the account's Containers limits apply. Every session with an environment uses one harness container and one sandbox container while a turn runs. A delegated child adds a harness container and shares the sandbox.
- Each object destroys its own container after 10 idle minutes: the harness container after its last poll or request, the sandbox after its last use (a running turn keeps it in use). A cancelled or failed turn destroys both at once, and deleting a session retires both objects for good. You pay for the running time.
- The sandbox is reused between turns while it holds the last committed workspace. A turn that starts on a reused sandbox costs a container wake-up at most. A turn after a cancel, a failure, a container loss or a fork pays a restore: an R2 read and package installation again.
- A completed turn writes one native checkpoint object (up to 32 MiB), one workspace backup (no expiry) and the artifacts under `/workspace/outputs`. Nothing deletes old objects; see [checkpoint operations](#checkpoint-operations).
- The turn deadline (`maxTurnMs`, 15 minutes by default) bounds a single turn, not a session or a tenant. Set account-level limits and provider budgets before exposing the API.

## Security boundaries in the deployment

Only trusted Workers should hold a Service Binding to this API; RPC callers supply the tenant themselves. Environment MCP commands, package installation and setup commands run in the sandbox under its network policy. Vault secrets live in the tenant's catalog object and are attached by the Worker when it proxies service-origin MCP requests. Model credentials live in the gateway. Setup-command effects outside `/workspace` persist while a sandbox is reused; see [SECURITY.md](../SECURITY.md).

## Checkpoint operations

Native snapshots use immutable per-session, per-generation keys. A completed turn commits native and workspace references only after both exist. Failed uploads can leave orphan objects. Physical deletion and retention are operator responsibilities: session deletion purges the session's SQLite storage and discovery, not its R2 objects. Workspace backups do not expire either; they are `workspaces/<id>.tar.zst` in the backup bucket (`backups/<id>/` for those Sandbox SDK 0.x wrote). A bucket lifecycle rule on `sessions/` and `artifacts/` in the checkpoint bucket and on the backup bucket is the practical answer, and the only expiry there is.

Workspace backups capture files; detached processes cannot resume. Snapshot at an application quiescent boundary. Do not use a checkpoint as evidence that an external deployment or payment happened exactly once.

## Local runtime notes

`pnpm test` exercises the production composition in workerd with SQLite Durable Objects and a scripted runtime driver. `pnpm test:codex` runs real Codex with an isolated home and a scripted Responses server; it never reads your Codex login. `pnpm test:harnesses` adds Claude Code and OpenCode, native history restoration and instantiated AI SDK connections through the official SDK clients.

Run the complete local smoke with:

```sh
pnpm test:containers
```

It uses a fresh persistence directory and a scripted model. For each harness it verifies native shell execution, the Claude Code and OpenCode tool replacements, a configured environment with a pinned skill, an inline plugin, a service-origin MCP server with a Vault credential, artifacts, isolation from the harness filesystem, a second turn after both containers are destroyed, sandbox reuse across completed turns and restore after cancellation, programmatic tool calling with parallel client calls, explicit cancellation, an abandoned workspace call ending as `programmatic_execution_uncertain`, a same-harness fork, a delegated subagent on the next runtime sharing the workspace, and a cross-runtime fork with the inherited workspace and transcript. The Codex fixture also covers Files API uploads, environment listings, image input, cached search at model egress, usage, an `environment: none` session and a `restricted` network policy (the allowed domain answers over HTTP and HTTPS, any other host 520), and checks with shortened idle timeouts that the harness and sandbox containers stop on their own idle alarms after a completed turn, and on deletion. It cleans up the containers it created and leaves logs and local R2/SQLite state in the printed temporary directory. `CF_SMOKE_HARNESSES=opencode` narrows the run to one runtime.

Cloudflare's local container proxy needs a route back to workerd. It expects the Docker bridge gateway (`172.17.0.1`) in workerd's own network namespace, which holds for rootful Docker and Docker Desktop. With rootless Docker the bridge lives in rootlesskit's network namespace, so the containers start but every request from them back to the Worker (`model.internal`, `sandbox.internal`) is refused and every turn fails; see the [known issue](known-issues.md). The remedy is to run wrangler inside rootlesskit's network namespace with `nsenter`, with a private bind mount of rootlesskit's `resolv.conf` over `/etc/resolv.conf` so name resolution works there. A project set up by the CLI gets this as `pnpm dev:rootless` (`create-cf-open-agents-api init` offers it when it detects a rootless engine, `init --rootless` adds it explicitly); the script also bridges `127.0.0.1:8787` back to the host, so the browser and SSH port forwarding work as usual.

In this repository, `pnpm test:containers` uses the same recipe by hand. On Linux with the standard user service:

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

`10.0.2.3` is slirp4netns's default resolver; `$XDG_RUNTIME_DIR/dockerd-rootless/resolv.conf`, which the generated script bind-mounts, names the same resolver and works when you changed it. The `--net` path above is the `--detach-netns` layout; without that flag use `/proc/$cf_open_agents_pid/ns/net`. The bind mount is private to the test process. No host routes, daemon configuration or system resolver change. Rootful Docker does not need this.

See [known issues](known-issues.md) for diagnostics that appear in successful local runs.
