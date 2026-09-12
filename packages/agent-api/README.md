# cf-open-agents-api

An independent, Apache-2.0 Agents API implementation for Cloudflare Workers.
The alpha targets `agents=v1` in OpenAI SDK 7.15.0 and supports a documented subset.

Entry points:

- `cf-open-agents-api`: wire schemas, public types, and the runtime driver contract.
- `cf-open-agents-api/cloudflare`: Worker/DO composition, Codex Container driver and Sandbox class.
- `cf-open-agents-api/ai-sdk`: optional durable harness accepting AI SDK 7 model instances.
- `cf-open-agents-api/tools`: typed function tools, search presets and immutable skill bundles.

The Cloudflare runtime requires Worker bindings for a tenant catalog, sessions,
checkpoints, and the selected harness. Codex uses two separate Containers and its
native remote exec-server protocol. State changes use Kysely with SQLite Durable
Object transactions; native and workspace checkpoints use R2.

Install `openai@^7.15.0` for the public SDK types. Install `ai@^7.0.97` when using the
AI SDK entry point. The repository workspace includes a deployable Worker example, Dockerfiles,
architecture, compatibility matrix, and contributor instructions.

This package does not emulate OpenAI's hosted infrastructure, remote registration,
artifacts, or subagents. Unsupported wire fields fail explicitly. Claude Code and
OpenCode require additional runtime drivers.
