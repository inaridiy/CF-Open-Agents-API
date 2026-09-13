---
name: native-harness-change
description: Change or debug this project's native runtime adapters, model gateway, or checkpoint restoration.
---

# Native harness changes

Use this workflow for Codex, Claude Code or OpenCode adapter behavior, gateway
translation, and native history recovery. Documentation-only mentions of these
components need the normal documentation checks.

Select context by the failing boundary:

| Boundary | Source and contract |
| --- | --- |
| Native process and protocol | `packages/supervisor/src/`; [driver extension contract](../../../docs/extending.md) |
| Model translation and streaming | `packages/agent-api/src/models.ts`, `models/`; [model protocols](../../../docs/extending.md#model-protocols) |
| Durable completion and recovery | `session.ts`, `containers.ts`, supervisor `checkpoint.ts`; [architecture](../../../docs/architecture.md) |
| Runtime package/image revisions | Package manifests, `docker/`, `harnesses.ts`; `pnpm check:docs` checks their agreement |

Preserve the native agent loop. The portable gateway performs one inference;
it is not a replacement agent loop. Model credentials stay in the Worker.
Native snapshots retain each runtime's own history and are committed with the
workspace snapshot before a turn is exposed as complete. Treat unknown execution
outcomes explicitly rather than replaying potentially completed side effects.

Use the installed runtime and local scripted endpoint to reproduce protocol
behavior. `tests/codex/` exercises app-server/exec-server; `tests/harnesses/`
exercises the three native adapters and gateway. Keep fixture model IDs and
credentials local: changing a scripted fixture does not require model selection
or a paid-provider comparison. Read the relevant test's setup before running it.

Choose checks from [CONTRIBUTING.md](../../../CONTRIBUTING.md#validation).
For recovery changes, show history restoration after the original process/home
is gone. For Container transport or R2 restore changes, use the Container smoke
and its [runtime prerequisites](../../../docs/deployment.md). A build alone does
not prove callback routing or WebSocket transport. Record unavailable prerequisites
as blockers and complete the independent checks.

Completion requires the observed defect to be repaired, affected boundary checks
to pass, and changed compatibility or setup contracts to be documented. Report
which runtimes and paths were exercised. Scripted inference proves integration
behavior, not real-provider compatibility or model quality.
