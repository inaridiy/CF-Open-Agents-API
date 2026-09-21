# Host an HTTP API

Use this path for Node, Python, or services outside your Cloudflare account. The same Agent Worker that serves Service Binding requests can expose authenticated HTTPS routes. The [deployment guide](deployment.md) covers its containers, R2 buckets and secrets; running any harness needs this repository's Docker images.

## Expose the Agent Worker

The example sets `workers_dev: false` and `preview_urls: false`. For an HTTPS API, add a custom domain or route, or enable `workers_dev` in `examples/worker/wrangler.jsonc`, before deploying. `pnpm deploy:check` validates the bundles without deploying.

Keep `API_TOKEN` (API authentication) separate from provider credentials. Replace the single-tenant `bearerTenant` authenticator when serving multiple tenants.

## Use the OpenAI SDK

```ts
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "https://agents.example.com/v1",
  apiKey: process.env.AGENT_API_TOKEN,
});
const session = await client.beta.agents.sessions.create(
  { agent: { model: "codex" }, environment: { type: "openai_hosted" } },
  { headers: { "Idempotency-Key": "task-123-session" } },
);
for await (const event of client.beta.agents.sessions.stream(session.id, {
  input: "Create /workspace/outputs/report.txt and summarize it.",
  idempotencyKey: "task-123-input",
})) {
  if (event.type === "agent.session.turn.output_text.delta") process.stdout.write(event.delta);
  if (event.type === "agent.session.turn.failed" && !event.turn.subagent_id)
    throw new Error(event.turn.error?.message ?? "Turn failed");
}
```

For local development, run `pnpm dev` and use `http://localhost:8787/v1`. Follow-up input, tool results, cancellation and pagination are the same SDK calls as in the [Service Binding guide](service-binding.md#run-a-turn-and-read-its-result). The [compatibility profile](compatibility.md) lists the implemented resources.

## Use raw HTTP

```sh
curl https://agents.example.com/v1/agents/sessions \
  -H "Authorization: Bearer $AGENT_API_TOKEN" \
  -H 'OpenAI-Beta: agents=v1' -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: task-123-session' \
  -d '{"agent":{"model":"codex"},"environment":{"type":"openai_hosted"},"input":"Write /workspace/outputs/report.txt, then summarize it."}'
```

The response is the session object (abbreviated):

```json
{
  "id": "sess_5f1c...",
  "object": "agent.session",
  "status": "in_progress",
  "error": null,
  "required_actions": [],
  "agent": {
    "model": "codex",
    "tools": [],
    "multi_agent": { "enabled": false, "max_concurrent_subagents": null }
  },
  "environment": {
    "type": "openai_hosted",
    "id": "env_9a2b...",
    "files": [],
    "skills": [],
    "plugins": []
  },
  "created_at": 1789516800,
  "last_active_at": 1789516800,
  "usage": null,
  "vault_ids": [],
  "metadata": {}
}
```

Poll `GET /v1/agents/sessions/<id>` with the same header until `status` is `idle`, `requires_action` or `failed`. `GET /v1/agents/sessions/<id>/items` and `/turns` hold the result. A failed turn also puts the session back to `idle` with `error` set, so a client that only looks at `status` cannot tell completion from failure; read the session's `error` and the turn's `error`, as the [demo app](../examples/demo/src/index.tsx) does. A `2xx` on the create request only means the task was accepted. Every response carries `x-request-id`; permanent `409` conflicts carry `x-should-retry: false`. Add `"stream": true` to the create body to receive an SSE stream that ends when the initial turn settles.

Live SSE is `GET /v1/agents/sessions/<id>/events`; reconnecting to it does not replay history. `GET /cf/v1/sessions/<id>/events?after=<seq>&limit=<rows>` replays the durable log from a sequence number, 100 rows per page by default and 1,000 at most, and `POST /cf/v1/sessions/<id>/fork` continues a committed session; both are extensions of this implementation. See [forks](environments-and-tools.md#fork-a-session).
