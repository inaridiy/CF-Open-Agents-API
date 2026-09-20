# create-cf-open-agents-api

Sets up the [CF-Open-Agents-API](https://github.com/inaridiy/CF-Open-Agents-API), an independent implementation of the OpenAI Agents API that runs Codex, Claude Code or OpenCode on your Cloudflare account. `init` creates a new Worker (with a demo app, or the API alone) or adds the API to a Workers project you already have: it writes the bindings, the composition, the Docker image snapshot and the local secrets. `setup` provisions the R2 buckets and production secrets, `doctor` checks the result. The library and this CLI are pre-release and publish under the npm `alpha` dist-tag; run them with `@alpha`.

## Quick start: a new Worker

Node 24, a package manager and a running Docker engine are the prerequisites; Workers AI needs no provider key, only `wrangler login`.

```sh
mkdir my-agents && cd my-agents
pnpm dlx create-cf-open-agents-api@alpha init     # choose the demo template and a provider; Workers AI needs no key
pnpm install
pnpm exec wrangler login
pnpm dev                                            # or pnpm dev:rootless when init offered it
```

In an empty directory `init` asks for the template: `demo` (default), a Hono + `hono/jsx` app where a prompt form creates a session, a progress page shows the transcript, subagents and artifacts, and the files under `/workspace/outputs` download as a zip; or `minimal`, the API alone with `src/index.ts` exporting `Agents` as the default export. `--template demo|minimal` skips the question. Then come the model provider (OpenAI, Anthropic, Workers AI or an OpenAI-compatible endpoint), the native runtimes to expose as presets (Codex, Claude Code, OpenCode), whether to add a Workers AI preset next to your provider and whether to enable programmatic tool calling. `--yes` takes every default.

Open <http://localhost:8787>, type a prompt, pick a preset and press Build. The first `wrangler dev` builds both Docker images, which takes several minutes. The repository's [QuickStart](https://github.com/inaridiy/CF-Open-Agents-API/blob/main/docs/quickstart.md) has screenshots, explains what happens under the hood and answers the first questions. The demo template publishes the Worker on workers.dev (`workers_dev: true`), and the deployed page has no login: anyone with the URL can create sessions on your account, so put Cloudflare Access in front of it or replace the page with your own auth before sharing it. The minimal template writes `workers_dev: false`, reachable through Service Bindings only; either is one line in `wrangler.jsonc` to change when you deploy.

## Quick start: an existing Workers project

Run `init` in the directory that holds `wrangler.jsonc` (a Vite + `@cloudflare/vite-plugin` project, a Hono Worker, anything Wrangler deploys). Your default export is untouched.

```sh
pnpm dlx create-cf-open-agents-api@alpha init
pnpm install
pnpm exec wrangler login
pnpm dev            # or: pnpm exec wrangler dev; Docker must be running
```

Your Worker reaches the API through the `AGENTS` binding, which points at this Worker's `Agents` entrypoint. Hand it to the official client with `tenantFetch`: the binding is the credential, your code names the tenant, and no token crosses it.

```ts
import { type AgentRPC, tenantFetch } from "cf-open-agents-api/cloudflare";
import { Hono } from "hono";
import OpenAI from "openai";

const app = new Hono<{ Bindings: { AGENTS: Fetcher & AgentRPC } }>();

app.post("/tasks", async (c) => {
  const client = new OpenAI({
    apiKey: "service-binding", // the SDK requires a value; the API never reads it on this path
    baseURL: "https://agents.internal/v1",
    fetch: tenantFetch(c.env.AGENTS, "default"),
  });
  const session = await client.beta.agents.sessions.create(
    {
      agent: { model: "codex" },
      environment: { type: "openai_hosted" },
      input: "Write /workspace/outputs/report.txt with a short greeting, then read it back.",
    },
    { headers: { "Idempotency-Key": crypto.randomUUID() } },
  );
  return c.json({ id: session.id });
});
```

Poll `client.beta.agents.sessions.retrieve(id)` until `status` is `idle`, then read `session.error` and `sessions.items.list(id)`. Derive the tenant from your own verified identity, never from a request body. The typed RPC methods (`c.env.AGENTS.createSession("default", ...)`) and a forwarded route for bearer-token callers (`app.all("/v1/*", (c) => c.env.AGENTS.fetch(c.req.raw))`) are the other ways in; see the [Service Binding guide](https://github.com/inaridiy/CF-Open-Agents-API/blob/main/docs/service-binding.md).

## What init writes

Idempotently; a second run reports what it kept:

| File                                                  | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `wrangler.jsonc`                                      | Comments kept. Adds `nodejs_compat` (and `enable_ctx_exports` for a compatibility date before 2025-11-17), the four SQLite Durable Objects and their migration, the two containers built from the snapshot, the `CHECKPOINTS` and `BACKUP_BUCKET` R2 buckets with `vars.BACKUP_BUCKET_NAME`, the `MODEL_GATEWAY` and `AGENTS` self Service Bindings, `CODE_LOADER`, and `ai` as `{ "binding": "AI", "remote": true }`. A new project gets the pinned `compatibility_date` (`2026-09-12`, the date the workspace examples run with) rather than today's date, because the workerd bundled with the pinned Wrangler lags behind the calendar |
| `src/agents.ts`                                       | The composition: presets, the model gateway registry, `tiers` for Claude Code subagents and `defineAgentWorker`, with comments explaining each part. Sits next to your Wrangler entry (`--agents-file` moves it); the minimal template composes in `src/index.ts` instead                                                                                                                                                                                                                                                                                                                                                                  |
| your entry (`main`)                                   | One appended line re-exporting `Agents`, `Models`, `SessionDO`, `TenantCatalogDO`, `HarnessDO`, `SandboxDO` and `ContainerProxy`; your default export is untouched                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `src/index.tsx`, `src/ui.tsx`, `README.md`            | Demo template only: the Hono app (routes, the `openai` client over `tenantFetch`, the zip download), the `hono/jsx` views, and a README describing the routes                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `scripts/dev-rootless.sh`, `scripts/netns-bridge.mjs` | With rootless Docker only (asked when detected, `--rootless` forces, `--no-rootless` skips): the `dev:rootless` script described below                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `.cf-open-agents-api/`                                | The repository snapshot the two Dockerfiles build from (`docker/`, `packages/`, the lockfile). Git-ignored and restored by the `postinstall` hook                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `.dev.vars`, `.dev.vars.example`                      | A random `API_TOKEN` (32+ characters, read by `bearerTenant` for HTTP callers), the provider key line and `LOCAL_BACKUPS=true` for local development                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `package.json`                                        | `cf-open-agents-api` with its peers `effect`, `openai`, `ai`, `zod`, the provider package, this CLI as a devDependency, `postinstall: create-cf-open-agents-api vendor`, the `types` script (`wrangler types env.d.ts`, the file `tsconfig.json` and `.gitignore` name) and `dev:rootless` when chosen. Other versions you already pinned are kept (`--force` overwrites)                                                                                                                                                                                                                                                                  |
| `.gitignore`, `tsconfig.json`                         | Ignore the snapshot and `.dev.vars`; exclude the snapshot from a broad `include`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `pnpm-workspace.yaml`                                 | pnpm projects only (a `packageManager` field, a lockfile, or the CLI run through `pnpm dlx`): `allowBuilds` for `esbuild` and `workerd`, without which pnpm 11 fails `pnpm exec wrangler` with `ERR_PNPM_IGNORED_BUILDS`. A project inside a pnpm workspace gets a note naming the workspace file instead                                                                                                                                                                                                                                                                                                                                  |

The generated composition registers several models per provider so presets and tiers can point at different ones (with OpenAI: `codex` as a native Responses connection, `primary` and `fast` through the AI SDK; with Workers AI: `workers` and `workersQwen`; with Anthropic: native `opus`, `sonnet` and `haiku`, and the `claude` preset gets `tiers: { haiku: "haiku", sonnet: "sonnet" }`). The preset names clients send are `codex`, `claude`, `opencode` and `workers`, depending on your choices.

Binding names are fixed by the library (`SESSIONS`, `CATALOG`, `HARNESS`, `SANDBOX`, `CHECKPOINTS`, `BACKUP_BUCKET`, `MODEL_GATEWAY`, `CODE_LOADER`, `AI`). An existing binding with one of these names but another class stops the run before anything is written. `wrangler.toml` is not supported; convert it to `wrangler.jsonc` first. The generated `examples/demo` and `examples/worker` in the repository are the two templates, generated.

## Commands

| Command                      | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `init [directory]` (default) | Create or retrofit, as above. Flags: `--yes`, `--force`, `--dry-run`, `--dir`, `--name`, `--template demo\|minimal`, `--provider`, `--base-url`, `--model`, `--harnesses codex,claude-code,opencode`, `--workers-ai`, `--no-code-loader`, `--rootless` / `--no-rootless`, `--agents-file`, `--install`, `--ref`, `--source`, `--library`, `--cli-package`                                                                                                                                      |
| `setup [directory]`          | Production: `wrangler r2 bucket create` for both buckets (existing ones are skipped), then `wrangler secret bulk` with `API_TOKEN`, the provider key, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` and `CLOUDFLARE_R2_ACCOUNT_ID` in one call. Values are prompted, or read from the environment with `--from-env`. `--dry-run` prints the commands                                                                                                                                              |
| `doctor [directory]`         | Checks only: Node 24, wrangler, a reachable Docker engine, `docker rootless` (fails when the engine is rootless and the `dev:rootless` script is missing), `wrangler login`, the binding agreement rules (`MODEL_GATEWAY` and `AGENTS` point at this Worker, `BACKUP_BUCKET_NAME` equals the bucket, SQLite migrations, snapshot Dockerfiles), the snapshot version and the `.dev.vars` token length. It notes that one `wrangler dev` per Dockerfile may run at a time. `--json`, `--offline` |
| `vendor [directory]`         | Refreshes `.cf-open-agents-api/` from the tag matching this CLI's version (`--ref` for another ref, `--source` for a local checkout). The `postinstall` hook runs it; `CF_OPEN_AGENTS_API_SKIP_VENDOR=1` skips it and `CF_OPEN_AGENTS_API_SOURCE` names a checkout                                                                                                                                                                                                                             |

Every command reports what it created, updated and skipped, and explains each decision in Notes. `--dry-run` computes the same plan without writing.

## Rootless Docker

Wrangler's local container proxy publishes the containers' ingress ports but expects the Docker bridge gateway (`172.17.0.1`) to be in workerd's own network namespace for the way back. With rootless Docker that bridge lives in rootlesskit's namespace, so `wrangler dev` starts, the session and the containers come up, and every turn fails with `internal_error` or `connection_failed` because the runtime cannot reach `model.internal` or `sandbox.internal`.

This is a temporary workaround for Wrangler's local container proxy assuming a rootful bridge; it goes away when Wrangler supports rootless engines. On Linux `init` runs `docker info --format '{{json .SecurityOptions}}'` (bounded by a 5 second timeout) and, when it reports `name=rootless`, offers (default yes) a `dev:rootless` script (`WRANGLER="pnpm exec wrangler" sh scripts/dev-rootless.sh`, with your package manager's exec prefix; the script defaults to `npx wrangler`). The script enters rootlesskit's user and network namespace with `nsenter --user --net --preserve-credentials unshare --mount`, bind-mounts `$XDG_RUNTIME_DIR/dockerd-rootless/resolv.conf` over `/etc/resolv.conf` inside that mount namespace so DNS works there, handles the `--detach-netns` layout (detected by the `netns` file), and runs `wrangler dev` inside. `scripts/netns-bridge.mjs`, a small Node relay, bridges `127.0.0.1:$PORT` (default 8787) on the host to wrangler in the namespace over a Unix socket, so the browser and SSH port forwarding work as usual. Nothing about the Docker daemon or the host network changes. Rootful Docker and Docker Desktop do not need it; `doctor` tells you which case you are in. The [known issues](https://github.com/inaridiy/CF-Open-Agents-API/blob/main/docs/known-issues.md) page has the diagnostics.

## Production

```sh
pnpm dlx create-cf-open-agents-api@alpha doctor
pnpm dlx create-cf-open-agents-api@alpha setup     # buckets and secrets
pnpm exec wrangler deploy                          # builds and pushes both images; several minutes the first time
```

Containers need the Workers Paid plan. The R2 API token (`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`) comes from the Cloudflare dashboard, R2 → Manage R2 API Tokens, with Object Read & Write on the workspaces bucket; `setup` tells you when it needs it. `LOCAL_BACKUPS` stays out of production. See [deployment](https://github.com/inaridiy/CF-Open-Agents-API/blob/main/docs/deployment.md) for the cost model.

## Running an unpublished checkout

`init` pins `cf-open-agents-api` and this CLI to its own version, which `pnpm install` takes from npm. To try a change before it is published, build both from a checkout and point the CLI at the tarballs:

```sh
git clone https://github.com/inaridiy/CF-Open-Agents-API.git && cd CF-Open-Agents-API
pnpm install --frozen-lockfile && pnpm build
pnpm --filter cf-open-agents-api pack --pack-destination /tmp/cfo
pnpm --filter create-cf-open-agents-api pack --pack-destination /tmp/cfo
node packages/create-cf-open-agents-api/dist/cli.js init <your-project> \
  --source "$PWD" --library /tmp/cfo/cf-open-agents-api-<version>.tgz --cli-package /tmp/cfo/create-cf-open-agents-api-<version>.tgz
```

`--source` snapshots the checkout instead of downloading a tag archive; `--library` and `--cli-package` write `file:` dependencies.

## Requirements

Node 24, a package manager (pnpm, npm, yarn or bun; detected from the lockfile), `tar` on `PATH` for the archive download, Docker for local development and Wrangler 4.131 or newer. `dev:rootless` is Linux only and needs `nsenter` and `unshare` from util-linux. Windows is untested. Named Wrangler environments (`env.*`) are neither changed nor checked.
