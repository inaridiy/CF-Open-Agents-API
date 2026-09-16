# Deployment and verification

The example in `examples/worker` is one Worker that exports every class: `Agents` (the API, also the default export), `SessionDO`, `TenantCatalogDO`, `HarnessDO`, `SandboxDO`, `ContainerProxy` and the `Models` entrypoint. It binds two Container images, two R2 buckets, a loopback Service Binding to `Models`, a `CODE_LOADER` worker loader and the `AI` binding. `HarnessDO` uses the `basic` instance type and `SandboxDO` uses `standard-1`; tune both after measurement. The Sandbox package and its image both pin `0.13.0-next.751.1`.

Running any harness needs this repository's Docker images: `docker/Harness.Dockerfile` (the supervisor, Codex and OpenCode on Node 24) and `docker/Sandbox.Dockerfile` (Cloudflare's sandbox image plus `python3` and Codex `exec-server`). Wrangler builds them from `examples/worker/wrangler.jsonc`; a project set up by the [CLI](../packages/create-cf-open-agents-api/README.md) builds the same Dockerfiles from its `.cf-open-agents-api/` snapshot.

## Production walkthrough with the CLI

In a project the CLI set up, provisioning is two commands; `doctor` checks the toolchain, the binding agreement rules and the local token first:

```sh
pnpm dlx create-cf-open-agents-api@alpha doctor
pnpm dlx create-cf-open-agents-api@alpha setup     # wrangler r2 bucket create ×2, wrangler secret bulk with every secret
pnpm exec wrangler deploy
```

`setup` prompts for the values (or reads them from the environment with `--from-env`) and tells you when it needs the R2 API token from the dashboard. The manual steps below are what it runs.

## Production walkthrough by hand

1. Create the R2 buckets, or rename them in `examples/worker/wrangler.jsonc` (`BACKUP_BUCKET_NAME` must equal the `BACKUP_BUCKET` binding's bucket name; `pnpm check:docs` verifies that in the repository, `create-cf-open-agents-api doctor` in your project):

   ```sh
   pnpm exec wrangler r2 bucket create cf-open-agents-api-checkpoints
   pnpm exec wrangler r2 bucket create cf-open-agents-api-workspaces
   ```

2. Create an R2 API token with object read and write on the workspaces bucket. The Sandbox SDK uses it to sign the presigned URLs that the sandbox container uses for backups and restores.

3. Set the secrets. Each is read by exactly one component:

   | Secret                                                  | Read by                                                                                                   |
   | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
   | `API_TOKEN`                                             | The example authenticator `bearerTenant` in `examples/worker/src/index.ts`; at least 32 random characters |
   | `OPENAI_API_KEY`                                        | The example model gateway (`nativeModel` and `aiSDKModel` presets); never leaves the Worker               |
   | `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`              | `@cloudflare/sandbox`, to create scoped presigned URLs for workspace backups                              |
   | `CLOUDFLARE_R2_ACCOUNT_ID` (or `CLOUDFLARE_ACCOUNT_ID`) | `@cloudflare/sandbox`, to address the R2 endpoint                                                         |

   ```sh
   cd examples/worker
   for name in API_TOKEN OPENAI_API_KEY R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY CLOUDFLARE_R2_ACCOUNT_ID; do
     pnpm exec wrangler secret put "$name"
   done
   ```

   `BACKUP_BUCKET_NAME` is a plain variable read by the Sandbox SDK. `LOCAL_BACKUPS` is read by the library and must stay unset in production; it switches backups to Wrangler's local bucket emulation. The sandbox container itself never receives R2 or model credentials, only short-lived presigned URLs.

4. Decide how the API is reached. The example sets `workers_dev: false` and `preview_urls: false`; a Service Binding works without any public route. Add a custom domain or route only if you host the HTTP API, and replace the single-tenant authenticator first.

5. Deploy:

   ```sh
   pnpm build
   pnpm deploy:check                                  # dry run of both Workers, builds both images
   pnpm exec wrangler deploy --config examples/worker/wrangler.jsonc
   pnpm exec wrangler deploy --config examples/caller/wrangler.jsonc   # optional
   ```

   The first deploy pushes both images to Cloudflare's registry and can take several minutes.

6. Verify:

   ```sh
   pnpm exec wrangler containers list
   pnpm exec wrangler containers images list
   ```

   Then create a session with `environment: { type: "openai_hosted" }` through the caller or your own client and retrieve `GET /v1/agents/environments/{id}`; `status: "connected"` proves that the sandbox container started and that the harness container can reach it. `pnpm exec wrangler tail --config examples/worker/wrangler.jsonc` shows `Native harness diagnostics` when a native execution stops, which is the first place to look when a turn fails with `native_harness_failed`.

## Presets and models

The example registers four presets. `coding` runs Codex through `nativeModel` with the Responses protocol, so images, native reasoning, hosted web search (`webSearch: true`) and structured output reach OpenAI unchanged. `claude` and `opencode` run the other runtimes through the portable AI SDK adapter against the same key. `workers` runs Codex against Workers AI. `coding`, `claude` and `opencode` list each other as `delegates`. See [extending](extending.md) for the options.

The gateway enforces a session's search mode at model egress: `disabled` removes the search tool, `cached` disables external web access, `live` enables it. This also corrects Codex `0.154.0` promoting cached search to live under full-access execution.

## Scaling and cost

- `max_instances` on each container class caps concurrent sessions with a running turn. Every session with an environment uses one harness container and one sandbox container while a turn runs. A delegated child adds a harness container and shares the sandbox.
- Both classes set `sleepAfter` to 10 minutes. An idle session keeps its pair alive for that long after the last activity, then the platform stops them. You pay for the running time.
- The sandbox is reused between turns while it holds the last committed workspace. A turn that starts on a reused sandbox costs a container wake-up at most. A turn after a cancel, a failure, a container loss or a fork pays a restore: an R2 read, package installation and setup commands again.
- A completed turn writes one native checkpoint object (up to 32 MiB), one workspace backup (30-day TTL) and the artifacts under `/workspace/outputs`. Nothing deletes old objects; see [checkpoint operations](#checkpoint-operations).
- The turn deadline (`maxTurnMs`, 15 minutes by default) bounds a single turn, not a session or a tenant. Set account-level limits and provider budgets before exposing the API.

## Security boundaries in the deployment

Only trusted Workers should hold a Service Binding to this API; RPC callers supply the tenant themselves. Environment MCP commands, package installation and setup commands run in the sandbox under its network policy. Vault secrets live in the tenant's catalog object and are attached by the Worker when it proxies service-origin MCP requests. Model credentials live in the gateway. Setup-command effects outside `/workspace` persist while a sandbox is reused; see [SECURITY.md](../SECURITY.md).

## Checkpoint operations

Native snapshots use immutable per-session, per-generation keys. A completed turn commits native and workspace references only after both exist. Failed uploads can leave orphan objects. Physical deletion and retention are operator responsibilities: session deletion purges the session's SQLite storage and discovery, not its R2 objects. A bucket lifecycle rule on `sessions/`, `artifacts/` and the backup bucket is the practical answer.

Workspace backups capture files; detached processes cannot resume. Snapshot at an application quiescent boundary. Do not use a checkpoint as evidence that an external deployment or payment happened exactly once.

## Local runtime notes

`pnpm test` exercises the production composition in workerd with SQLite Durable Objects and a scripted runtime driver. `pnpm test:codex` runs real Codex with an isolated home and a scripted Responses server; it never reads your Codex login. `pnpm test:harnesses` adds Claude Code and OpenCode, native history restoration and instantiated AI SDK connections through the official SDK clients.

Run the complete local smoke with:

```sh
pnpm test:containers
```

It uses a fresh persistence directory and a scripted model. For each harness it verifies native shell execution, the Claude Code and OpenCode tool replacements, a configured environment with a pinned skill, an inline plugin, a service-origin MCP server with a Vault credential, artifacts, isolation from the harness filesystem, a second turn after both containers are destroyed, sandbox reuse across completed turns and restore after cancellation, programmatic tool calling with parallel client calls, explicit cancellation, an abandoned workspace call ending as `programmatic_execution_uncertain`, a same-harness fork, a delegated subagent on the next runtime sharing the workspace, and a cross-runtime fork with the inherited workspace and transcript. The Codex fixture also covers Files API uploads, environment listings, image input, cached search at model egress, usage and an `environment: none` session. It cleans up the containers it created and leaves logs and local R2/SQLite state in the printed temporary directory. `CF_SMOKE_HARNESSES=opencode` narrows the run to one runtime.

Cloudflare's local container proxy needs a route back to workerd. Rootless Docker with `--detach-netns` can place the Docker bridge in a different namespace from both the host and `docker run --network host`. In that configuration, run the smoke inside rootlesskit's network namespace. On Linux with the standard user service:

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

The DNS address is slirp4netns's default; use your rootlesskit resolver if you changed it. The bind mount is private to the test process. No host routes, daemon configuration or system resolver change. Rootful Docker does not need this.

See [known issues](known-issues.md) for diagnostics that appear in successful local runs.
