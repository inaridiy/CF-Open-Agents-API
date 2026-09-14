# Development agent guidance

[AGENTS.md](../AGENTS.md) maps the codebase, constraints and validation commands.
[CLAUDE.md](../CLAUDE.md) imports that same entrypoint. Select checks from
[CONTRIBUTING.md](../CONTRIBUTING.md#validation); keep resumable work in
[project work notes](../.agents/PLANS.md).

## Skills and ownership

| Skill | Purpose | Source |
| --- | --- | --- |
| [durable-objects](../.agents/skills/durable-objects/SKILL.md) | SQLite DO state, RPC, alarms and concurrency | Cloudflare |
| [effect-ts](../.agents/skills/effect-ts/SKILL.md) | Effect repository setup | Effect-TS |
| [sandbox-next](../.agents/skills/sandbox-next/SKILL.md) | Preview Sandbox lifecycle and backups | Cloudflare |
| [workers-best-practices](../.agents/skills/workers-best-practices/SKILL.md) | Worker runtime and bindings | Cloudflare |
| [wrangler](../.agents/skills/wrangler/SKILL.md) | Wrangler commands and configuration | Cloudflare |
| [native-harness-change](../.agents/skills/native-harness-change/SKILL.md) | Native adapters, gateway and recovery | This repository |

`.agents/skills/` contains the installed snapshots. `.claude/skills/` contains
relative aliases. [skills-lock.json](../skills-lock.json) preserves installer
provenance; [NOTICE](../NOTICE) identifies licenses and local modifications.
Update snapshots deliberately and preserve their upstream license notices.
Only `native-harness-change` is authored as part of this repository.

The installed Effect setup skill includes bootstrap examples for other releases.
This workspace develops and tests against Effect 3.22.2; inspect installed sources
before changing its code. Sandbox SDK and Docker image revisions must match.

## Checks and generated files

`pnpm check:harness` runs the repository-owned `scripts/check-harness.mjs`. It
checks authored Markdown links, entrypoint imports, skill aliases and provenance.
Run `pnpm test:scripts` when changing checker behavior. Neither command downloads
skills or requires access to a private repository.

`dist/`, `examples/worker/env.d.ts` and `examples/caller/env.d.ts` are generated, ignored outputs. Build them
with `pnpm build` and `pnpm types`; edit their source rather than checking them in.
Keep validation fixtures under `tests/` and out of production package exports.
