# Development agent guidance

[AGENTS.md](../AGENTS.md) is the entrypoint for coding agents; [CLAUDE.md](../CLAUDE.md) imports it. Choose checks from [CONTRIBUTING.md](../CONTRIBUTING.md#validation) and keep resumable work in [project work notes](../.agents/PLANS.md).

## Toolchain

| Command                   | What runs                                                                                                                        |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm lint`               | `ultracite check --type-aware`: oxlint with type-aware rules, the repository plugin and an oxfmt formatting check                |
| `pnpm format`             | `ultracite fix --type-aware`: applies safe lint fixes and formats                                                                |
| `pnpm typecheck`          | `tsc --noEmit` on TypeScript 7, patched by `@effect/tsgo` so Effect language-service diagnostics appear inline                   |
| `pnpm effect:diagnostics` | The Effect language-service diagnostics alone, as text                                                                           |
| `pnpm test:scripts`       | `node --test` over the checker scripts, the container smoke helpers and the lint plugin's rule tests (`scripts/lint/*.test.mjs`) |

`prepare` runs `effect-tsgo patch --typescript --oxlint` on install; a fresh `pnpm install --frozen-lockfile` is enough. Lint rules live in `oxlint.config.ts` and formatting in `oxfmt.config.ts` (100 columns, Markdown prose wrapping preserved, no trailing commas in JSON so `JSON.parse` readers keep working). Format only the files you touch: `pnpm exec oxfmt <files>`.

`oxlint.config.ts` picks a subset of Ultracite's core preset rather than the whole of it: the correctness rules, the promoted `no-shadow`, `no-unsafe-*` and `no-useless-undefined` families, and the `complexity` and `no-nested-ternary` quality rules are all errors everywhere; `pnpm lint` reports zero findings on a clean tree. The repository plugin `scripts/lint/agent-api-plugin.mjs` is loaded through `jsPlugins` and adds three rules that enforce the [Effect house rules](effect.md#the-five-house-rules) the type checker cannot see:

| Rule                                  | Scope                    | What it rejects                                                                                                                                                                                                                               |
| ------------------------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent-api/no-run-in-transaction`     | Every file               | `Effect.run*`, `runPromise`, `runSync` or `runtime.run*` inside a callback passed to `transaction`, `transactionSync` or a repository's `read`. The callback type already rejects an Effect result; this catches a runner hidden in the body. |
| `agent-api/no-run-below-entrypoint`   | `packages/agent-api/src` | A runner outside the allow-listed entrypoint files (`effect.ts`, `service.ts`, `http/*.ts`, `session.ts`, `containers.ts`, `catalog.ts`, `models.ts`, `tools.ts`), or inside one without `// lint: entrypoint` on the line above.             |
| `agent-api/no-api-error-construction` | `packages/agent-api/src` | `new ApiError(...)` outside `errors.ts` and `api-error.ts`; fail with a tagged domain error and let `toApiError` project it.                                                                                                                  |

The marker convention makes every boundary runner visible in a diff and a grep: `grep -rn "lint: entrypoint" packages/agent-api/src` lists them. The rules are syntactic; a transaction callback passed by reference is not followed.

## Vendored skills

`.agents/skills/` holds vendored agent skills: instructions a coding agent loads for a task. `.claude/skills/` contains relative symlinks to them.

| Skill                                                                       | Purpose                                      | Source          |
| --------------------------------------------------------------------------- | -------------------------------------------- | --------------- |
| [durable-objects](../.agents/skills/durable-objects/SKILL.md)               | SQLite DO state, RPC, alarms and concurrency | Cloudflare      |
| [effect-ts](../.agents/skills/effect-ts/SKILL.md)                           | Effect repository setup                      | Effect-TS       |
| [sandbox-next](../.agents/skills/sandbox-next/SKILL.md)                     | Preview Sandbox lifecycle and backups        | Cloudflare      |
| [workers-best-practices](../.agents/skills/workers-best-practices/SKILL.md) | Worker runtime and bindings                  | Cloudflare      |
| [wrangler](../.agents/skills/wrangler/SKILL.md)                             | Wrangler commands and configuration          | Cloudflare      |
| [native-harness-change](../.agents/skills/native-harness-change/SKILL.md)   | Native adapters, gateway and recovery        | This repository |

Provenance is checked, not assumed. [skills-lock.json](../skills-lock.json) records each upstream skill's source repository, path and content hash as installed; [NOTICE](../NOTICE) lists the licenses and the commits at which they were verified, and each vendored directory keeps its upstream `LICENSE`. `pnpm check:harness` fails when a skill lacks its `SKILL.md`, its Claude alias, a lock entry with source, path and hash, or its `LICENSE`, and when the lock or the alias directory names a skill that no longer exists. `.agents/harness.json` lists the skills authored here (`localSkills`), which need no upstream provenance. Update a vendored snapshot deliberately, keep its license notice, and record the new hash.

The vendored Effect skill includes bootstrap examples for other releases. This workspace develops against Effect 3.22.2; inspect installed sources before changing Effect code. Sandbox SDK and Docker image revisions must match.

## Checks and generated files

`pnpm check:harness` runs `scripts/check-harness.mjs`: relative Markdown links in the documents listed in `.agents/harness.json` and every file under `docs/` must resolve, `CLAUDE.md` must import `AGENTS.md`, and the skill rules above must hold. `pnpm check:docs` runs `scripts/check-docs.mjs`: every non-lifecycle `package.json` script appears in README, the README title matches the repository name, the package README names every export entrypoint, the gateway binds its own Worker, the backup variable matches the R2 binding, and the Sandbox, Codex, OpenCode and Claude Agent SDK pins agree across manifests, Dockerfiles and `harnesses.ts`. Run `pnpm test:scripts` when changing either checker or the lint plugin. Neither checker downloads anything.

`dist/`, `examples/worker/env.d.ts` and `examples/caller/env.d.ts` are generated and ignored. Build them with `pnpm build` and `pnpm types`; edit their sources instead. Keep validation fixtures under `tests/` and out of the published package.
