# Working on CF-Open-Agents-API

This is a pnpm TypeScript workspace: a Workers API with SQLite Durable Objects,
R2 and Containers, plus a Node supervisor for Codex, Claude Code and OpenCode.
AI SDK adapts models; the native runtimes own their agent loops.

| When working on | Start with |
| --- | --- |
| Setup, commands, test selection | [CONTRIBUTING.md](CONTRIBUTING.md#validation) and [README.md](README.md#develop) |
| Service boundaries or durable execution | [docs/architecture.md](docs/architecture.md) |
| Public HTTP/RPC behavior | [docs/compatibility.md](docs/compatibility.md) and `packages/agent-api/src/protocol.ts` |
| Native runtime, model gateway, checkpoint changes | [native-harness-change](.agents/skills/native-harness-change/SKILL.md) |
| Worker bindings, Docker, R2 or deployment | [docs/deployment.md](docs/deployment.md) |
| Skill selection, provenance or task prompts | [docs/development-harness.md](docs/development-harness.md) |
| Scope, authorization or completion decisions | [Contribution scope](CONTRIBUTING.md#scope-and-completion) |
| Resumable experiments or a handoff | [.agents/PLANS.md](.agents/PLANS.md) |
| A recurring validation diagnostic | [docs/known-issues.md](docs/known-issues.md); match the documented scope |

The API is an independent implementation; its name does not imply use of
Cloudflare's `agents` package. Persistence uses Kysely with synchronous SQLite
transactions. The Sandbox package is pinned to the preview line; its image must
match. Confirm versions in package manifests.

Use the [conditional validation table](CONTRIBUTING.md#validation). Run commands
from the repository root with the pinned pnpm. The scripted local suites require
no production credentials; Docker builds and native binaries have additional
prerequisites listed in README. The example's `pnpm dev` can call live providers.

`dist/`, generated binding types and installed Skill snapshots have separate
ownership; see the development harness guide before changing them. Claude's
entrypoint imports this file.

## Learning more about Effect

This repository uses Effect 3.22.2. Before writing Effect code, read the affected
package's `node_modules/effect/AGENTS.md` completely if provided by that release.
The pinned release has no such file; consult `node_modules/effect/src` and the
Effect v3 documentation for signatures and semantics. Preserve the selected pin.
