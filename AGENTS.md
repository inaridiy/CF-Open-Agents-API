# Working on CF-Open-Agents-API

This is a pnpm TypeScript workspace: a Workers API with SQLite Durable Objects, R2 and Containers, plus a Node supervisor for Codex, Claude Code and OpenCode. The native runtimes own their agent loops; the model gateway performs single inferences.

| When working on                                   | Start with                                                                              |
| ------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Setup, commands, test selection                   | [CONTRIBUTING.md](CONTRIBUTING.md#validation) and [README.md](README.md#develop)        |
| Service boundaries or durable execution           | [docs/architecture.md](docs/architecture.md)                                            |
| Public HTTP/RPC behavior                          | [docs/compatibility.md](docs/compatibility.md) and `packages/agent-api/src/protocol.ts` |
| Effect code                                       | [docs/effect.md](docs/effect.md), the five house rules                                  |
| Native runtime, model gateway, checkpoint changes | [native-harness-change](.agents/skills/native-harness-change/SKILL.md)                  |
| Worker bindings, Docker, R2 or deployment         | [docs/deployment.md](docs/deployment.md)                                                |
| Toolchain, vendored skills, checkers              | [docs/development-harness.md](docs/development-harness.md)                              |
| Scope, authorization or completion decisions      | [Contribution scope](CONTRIBUTING.md#scope-and-completion)                              |
| Resumable experiments or a handoff                | [.agents/PLANS.md](.agents/PLANS.md)                                                    |
| A recurring validation diagnostic                 | [docs/known-issues.md](docs/known-issues.md); match the documented scope                |

The API is an independent implementation; its name does not imply use of Cloudflare's `agents` package. Persistence uses Kysely with synchronous SQLite transactions. The Sandbox package is pinned to the preview line and its image must match. Confirm versions in the package manifests.

Run commands from the repository root with the pinned pnpm. `pnpm lint`, `pnpm format` (ultracite: oxlint and oxfmt) and `pnpm typecheck` (TypeScript 7 with `@effect/tsgo`) are the toolchain; format only the files you touch with `pnpm exec oxfmt <files>`. Select checks from the [validation table](CONTRIBUTING.md#validation). The scripted suites need no production credentials; Docker builds and native binaries have the prerequisites listed in README. `pnpm dev` and `pnpm dev:caller` can call live providers.

`dist/`, generated binding types and vendored skill snapshots have separate ownership; see the development harness guide before changing them.

## Effect

This repository uses Effect 3.22.2. Follow the five house rules in [docs/effect.md](docs/effect.md). The pinned release ships no `AGENTS.md`; consult `node_modules/effect/src` and the Effect v3 documentation for signatures and semantics. Preserve the pin.
