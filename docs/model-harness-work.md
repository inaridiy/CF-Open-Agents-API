# Model and harness separation

Decision (2026-09-12): AI SDK is a model adapter. Native Codex, Claude Code and
OpenCode retain their own agent loops. Model instances and provider credentials
live in a private Worker; Container requests carry only a registered model name.

The previous AI SDK harness has been removed. Configuration uses `agents` with
`{ harness, model }` presets and a `harnesses` driver factory. The model registry
is composed independently with `createModelGateway`. The public Agents API's
`agent.model` field continues to select a deployment preset.

The installed AI SDK 7.0.97 artifact has no inverse Responses/Messages server
export. The gateway therefore translates a bounded text/function profile around
one `streamText` call. Native passthrough is available for provider-specific state.
No second tool loop, provider credential serialization, or native checkpoint
conversion is introduced.

Runtime findings:

- Claude Agent SDK 0.3.268 bundles the actual CLI. `toolAliases` redirects builtins
  to SDK MCP tools, which call the separately assigned Sandbox. The adapter uses the installed official MCP SDK to avoid mixing current Zod
  field schemas with the Claude bundle's older Zod object parser.
- OpenCode 1.18.30 loads same-name custom tools ahead of builtins. The bundled
  plugin overrides bash/read/write/edit. A read-only config directory prevents
  OpenCode's background dependency installer from requiring Internet access.
- Native homes are checkpointed after process shutdown. Package caches and logs
  are excluded; native history databases and transcripts are retained. A turn is
  complete only after both native and workspace snapshots have been committed.
- Portable model requests carry text and functions. Provider reasoning and
  signatures are not replayed in this profile; native presets preserve them.

The dependency artifacts/exports and shared AI SDK provider versions were checked
before installation. New versions satisfy the workspace's 24-hour release-age
policy. See [extending](extending.md) for the public API, runtime versions, source
links and limitations, and [implementation](implementation.md) for acceptance gates.

Migration from the initial unreleased alpha: replace `models`/`drivers` service
options with `agents`/`harnesses`, use `/models` instead of `/ai-sdk`, and replace
`createCodexHarness` with `createHarness`. Remove the AI_HARNESS binding. If an old
example was already deployed, append a Wrangler migration deleting AIHarnessDO;
do not rewrite its deployed migration history. Existing AI SDK harness checkpoints
cannot be resumed by native harnesses; start new sessions for those presets.
