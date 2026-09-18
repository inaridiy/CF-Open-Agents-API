# create-cf-open-agents-api

Adds the [CF-Open-Agents-API](https://github.com/inaridiy/CF-Open-Agents-API) to a Cloudflare Workers project you already have, or creates a new Worker for it. One run writes the bindings, the composition, the Docker image snapshot and the local secrets; a second command provisions the R2 buckets and production secrets.

The library and this CLI are pre-release. Until they are on npm's `latest` tag, run them with the `@alpha` tag and see [Before the packages are published](#before-the-packages-are-published).

## Add the API to an existing Workers project

Run it in the directory that holds `wrangler.jsonc` (a Vite + `@cloudflare/vite-plugin` project, a Hono Worker, anything Wrangler deploys):

```sh
pnpm dlx create-cf-open-agents-api@alpha init
pnpm install
pnpm exec wrangler login
pnpm dev            # or: pnpm exec wrangler dev — Docker must be running
```

`init` asks for the model provider (OpenAI, Anthropic, Workers AI or an OpenAI-compatible endpoint), the native runtimes to expose as presets (Codex, Claude Code, OpenCode), whether to add a Workers AI preset next to your provider and whether to enable programmatic tool calling. `--yes` takes every default. Then it writes, idempotently:

| File                             | Change                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wrangler.jsonc`                 | Comments kept. Adds `nodejs_compat` (and `enable_ctx_exports` for a compatibility date before 2025-11-17), the four SQLite Durable Objects and their migration, the two containers built from the snapshot, the `CHECKPOINTS` and `BACKUP_BUCKET` R2 buckets with `vars.BACKUP_BUCKET_NAME`, the `MODEL_GATEWAY` and `AGENTS` self Service Bindings, `CODE_LOADER`, and `ai` for Workers AI |
| `src/agents.ts`                  | The composition: presets, the model gateway registry and `defineAgentWorker`. Sits next to your Wrangler entry (`--agents-file` moves it)                                                                                                                                                                                                                                                   |
| your entry (`main`)              | One appended line re-exporting `Agents`, `Models`, `SessionDO`, `TenantCatalogDO`, `HarnessDO`, `SandboxDO` and `ContainerProxy`; your default export is untouched                                                                                                                                                                                                                          |
| `.cf-open-agents-api/`           | The repository snapshot the two Dockerfiles build from (`docker/`, `packages/`, the lockfile). Git-ignored and restored by the `postinstall` hook                                                                                                                                                                                                                                           |
| `.dev.vars`, `.dev.vars.example` | A random `API_TOKEN` (32+ characters), the provider key line and `LOCAL_BACKUPS=true` for local development                                                                                                                                                                                                                                                                                 |
| `package.json`                   | `cf-open-agents-api` with its peers `effect`, `openai`, `ai`, `zod`, the provider package, this CLI as a devDependency and `postinstall: create-cf-open-agents-api vendor`. Other versions you already pinned are kept (`--force` overwrites)                                                                                                                                               |
| `.gitignore`, `tsconfig.json`    | Ignore the snapshot and `.dev.vars`; exclude the snapshot from a broad `include`                                                                                                                                                                                                                                                                                                            |
| `pnpm-workspace.yaml`            | pnpm projects only (a `packageManager` field, a lockfile, or the CLI run through `pnpm dlx`): `allowBuilds` for `esbuild` and `workerd`, without which pnpm 11 fails `pnpm exec wrangler` with `ERR_PNPM_IGNORED_BUILDS`. A project inside a pnpm workspace gets a note naming the workspace file instead                                                                                   |

Your Worker reaches the API through the `AGENTS` binding, which points at this Worker's `Agents` entrypoint:

```ts
// Hono, in your entry
app.all("/v1/*", (c) => c.env.AGENTS.fetch(c.req.raw));
// or the typed RPC surface
const session = await c.env.AGENTS.createSession("tenant", {
  agent: { model: "coding" },
  environment: { type: "openai_hosted" },
});
```

Binding names are fixed by the library (`SESSIONS`, `CATALOG`, `HARNESS`, `SANDBOX`, `CHECKPOINTS`, `BACKUP_BUCKET`, `MODEL_GATEWAY`, `CODE_LOADER`, `AI`). An existing binding with one of these names but another class stops the run before anything is written. `wrangler.toml` is not supported; convert it to `wrangler.jsonc` first.

## Create a new Worker

In an empty directory `init` writes a minimal project (`package.json`, `tsconfig.json`, `wrangler.jsonc`, `src/index.ts` exporting `Agents` as the default export) and then applies the same changes. It is the repository's `examples/worker`, generated. `--public` sets `workers_dev: true`; the default keeps the API private to Service Bindings.

```sh
mkdir my-agents && cd my-agents
pnpm dlx create-cf-open-agents-api@alpha init --yes
pnpm install && pnpm exec wrangler login && pnpm dev
curl -X POST http://localhost:8787/v1/agents/sessions \
  -H "Authorization: Bearer $(grep ^API_TOKEN= .dev.vars | cut -d= -f2)" \
  -H "Content-Type: application/json" -H "Idempotency-Key: first" \
  -d '{"agent":{"model":"coding"},"environment":{"type":"openai_hosted"},"input":"Write /workspace/outputs/hello.txt"}'
```

## Commands

| Command                      | Purpose                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `init [directory]` (default) | Retrofit or create, as above. Flags: `--yes`, `--force`, `--dry-run`, `--dir`, `--name`, `--provider`, `--base-url`, `--model`, `--harnesses codex,claude-code,opencode`, `--workers-ai`, `--no-code-loader`, `--public`, `--agents-file`, `--install`, `--ref`, `--source`, `--library`, `--cli-package`                                         |
| `setup [directory]`          | Production: `wrangler r2 bucket create` for both buckets (existing ones are skipped), then `wrangler secret bulk` with `API_TOKEN`, the provider key, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` and `CLOUDFLARE_R2_ACCOUNT_ID` in one call. Values are prompted, or read from the environment with `--from-env`. `--dry-run` prints the commands |
| `doctor [directory]`         | Checks only: Node 24, wrangler, a reachable Docker engine, `wrangler login`, the binding agreement rules (`MODEL_GATEWAY` and `AGENTS` point at this Worker, `BACKUP_BUCKET_NAME` equals the bucket, SQLite migrations, snapshot Dockerfiles), the snapshot version and the `.dev.vars` token length. `--json`, `--offline`                       |
| `vendor [directory]`         | Refreshes `.cf-open-agents-api/` from the tag matching this CLI's version (`--ref` for another ref, `--source` for a local checkout). The `postinstall` hook runs it; `CF_OPEN_AGENTS_API_SKIP_VENDOR=1` skips it and `CF_OPEN_AGENTS_API_SOURCE` names a checkout                                                                                |

Every command reports what it created, updated and skipped, and explains each decision in Notes. `--dry-run` computes the same plan without writing.

## Production

```sh
pnpm dlx create-cf-open-agents-api@alpha doctor
pnpm dlx create-cf-open-agents-api@alpha setup     # buckets and secrets
pnpm exec wrangler deploy                          # builds and pushes both images; several minutes the first time
```

Containers need the Workers Paid plan. The R2 API token (`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`) comes from the Cloudflare dashboard, R2 → Manage R2 API Tokens, with Object Read & Write on the workspaces bucket; `setup` tells you when it needs it. `LOCAL_BACKUPS` stays out of production.

## Before the packages are published

`init` pins `cf-open-agents-api` and this CLI to its own version; `pnpm install` needs them on npm. Until then, build both from a checkout and point the CLI at the tarballs:

```sh
git clone https://github.com/inaridiy/CF-Open-Agents-API.git && cd CF-Open-Agents-API
pnpm install --frozen-lockfile && pnpm build
pnpm --filter cf-open-agents-api pack --pack-destination /tmp/cfo
pnpm --filter create-cf-open-agents-api pack --pack-destination /tmp/cfo
node packages/create-cf-open-agents-api/dist/cli.js init <your-project> \
  --source "$PWD" --library /tmp/cfo/cf-open-agents-api-0.2.0.tgz --cli-package /tmp/cfo/create-cf-open-agents-api-0.2.0.tgz
```

`--source` snapshots the checkout instead of downloading a tag archive; `--library` and `--cli-package` write `file:` dependencies.

## Requirements

Node 24, a package manager (pnpm, npm, yarn or bun; detected from the lockfile), `tar` on `PATH` for the archive download, Docker for local development and Wrangler 4.131 or newer. Windows is untested. Named Wrangler environments (`env.*`) are neither changed nor checked.
