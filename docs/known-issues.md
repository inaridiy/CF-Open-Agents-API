# Development issues

All entries are scoped to the pinned versions and local tests. They are not a
blanket exemption for errors with a similar message.

| Component | Reproduction / scope | Treatment / removal condition |
| --- | --- | --- |
| workerd `1.20260911.1` | Cancelling an SSE response after an SDK turn finishes can log `abortRead() has been called`. | API tests assert the complete turn and all streamed text before cancellation. Investigate any occurrence before completion; recheck on workerd upgrade. |
| Sandbox `0.13.0-next.751.1` | Destroying a sandbox with a live exec-server process handle during the Container restore smoke can report an RPC stub not disposed. | The SDK's public `SandboxProcess` interface has no dispose method. The smoke explicitly destroys its Containers; no private SDK fields are accessed. Recheck the process-handle lifecycle on SDK upgrade. |
| Containers local emulation | Wrangler prints FUSE / SYS_ADMIN / AppArmor privilege warnings. | These come from Cloudflare's Docker emulation. They are not production Worker privileges. Recheck when the SDK changes local backup requirements. |
| pnpm `11.1.2` legacy deployment | `pnpm deploy --prod --legacy` reports shared-lockfile and peer warnings while generating a filtered production tree. | The resulting tree and workspace pass `pnpm peers check`; the supervisor runs from that tree in the Container smoke. Remove when migrating to pnpm's injected-workspace deployment. |

Rootless Docker routing instructions are in [deployment.md](deployment.md). They
were necessary on the development machine used for the initial smoke; builds alone
do not establish that outbound callbacks or native WebSockets work.
