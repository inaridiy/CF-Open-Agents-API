# Copy review — ten-chapter cut

Reviewed 2026-09-21 by a read-only reviewer with fresh context, checking every factual claim in `src/scenes/*.tsx` against README.md, docs/architecture.md, docs/compatibility.md, docs/environments-and-tools.md, docs/service-binding.md, docs/http-api.md, docs/extending.md, SECURITY.md, examples/worker/src/index.ts and packages/agent-api/src. `reference/independent-review.md` is the earlier review of the 48-second cut and still covers the captured footage and assets.

## Verdicts

Correct, with the supporting source: the SDK snippet's methods, fields and event type (docs/http-api.md, `openai` type definitions); `defineAgentWorker`, preset fields, `nativeModel`, `aiSDKModel`, `createWorkersAI`, `bearerTenant` and the `tiers` usage (examples/worker, docs/extending.md); "no container ever sees a key" and "model traffic leaves only through the gateway" (README, architecture §Models, tools and isolation, SECURITY.md); "no Internet access" for the harness container; the four durability rules (architecture §Durable execution, §Checkpoints); "streamed from the durable event log"; durable `required_actions`; skills as integrity-checked R2 bundles (`tools.ts` SHA-256 check); programmatic tools in a Dynamic Worker; delegation both ways (mutual `delegates` in the example); forks from a committed source; "one Worker exports every class"; pinned native binaries (`docker/Harness.Dockerfile`); the hook eyebrow, chips, npm name, `create-cf-open-agents-api@alpha init` and the GitHub URL; artifacts sealed by a checkpoint.

Fixed after review:

1. **Sandbox "no Internet access" badge — wrong.** SECURITY.md: the sandbox container has the network policy the environment configured. The badge now reads "network per policy"; only the harness carries "no Internet access".
2. **Export list read as complete — imprecise.** `TenantCatalogDO` and `ContainerProxy` are also bound. The line now elides with `/* … */`.
3. **"In the same sandbox" — imprecise.** The sandbox is reused only when it still holds the committed workspace (architecture §Sandbox reuse). Now: "The sandbox is reused when it still matches."
4. **"Native threads" — Codex's term only.** Now "native subagents with their own items and turns".
5. **MCP tile** now names service-origin servers, the case the Vault claim applies to.

Accepted as is: the SDK snippet omits the optional `Idempotency-Key`, which the route does not require; the web-search tile is a capability list although OpenCode has no hosted search (README Limitations); the composition chapter shows the example Worker's current presets and Workers AI model, not the recorded run's `coding` preset and `glm-4.7-flash` (DESIGN.md says so; the on-screen footage only says "Workers AI model").

Nothing on screen claims hosted-tool parity, encrypted reasoning or non-alpha stability; "Alpha" and "Independent implementation" are shown.
