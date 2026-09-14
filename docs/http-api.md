# Host an HTTP API

Use this path for Node, Python, or services outside your Cloudflare account.
The same Agent Worker that serves Service Binding requests can expose authenticated HTTPS routes.
The [deployment guide](deployment.md) covers its Containers, R2 buckets, and secrets.

## Expose the Agent Worker

The example defaults to `workers_dev: false` and `preview_urls: false` for binding use.
For an HTTPS API, configure a custom domain/route, or enable `workers_dev` in `examples/worker/wrangler.jsonc` before your deployment.
`pnpm deploy:check` validates packaging; it does not deploy anything.

Keep `API_TOKEN` for API authentication separate from provider credentials.
Replace the example authenticator when serving multiple tenants.

## Use the OpenAI SDK

```ts
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "https://agents.example.com/v1",
  apiKey: process.env.AGENT_API_TOKEN,
});
const session = await client.beta.agents.sessions.create({
  agent: { model: "coding" },
  environment: { type: "openai_hosted" },
}, { headers: { "Idempotency-Key": "task-123-session" } });
for await (const event of client.beta.agents.sessions.stream(session.id, {
  input: "Create /workspace/outputs/report.txt and summarize it.",
  idempotencyKey: "task-123-input",
})) {
  if (event.type === "agent.session.turn.output_text.delta") process.stdout.write(event.delta);
  if (event.type === "agent.session.turn.failed" && !event.turn.subagent_id) throw new Error("Turn failed");
}
```

For local development, run `pnpm dev` and use `http://localhost:8787/v1`.
Use the [recommended guide](service-binding.md#run-a-turn-and-read-its-result) for follow-up input, tool results, cancellation, and pagination; those SDK calls are identical over HTTP.
The [compatibility profile](compatibility.md) states which official resources are implemented.

## Use raw HTTP

```sh
curl https://agents.example.com/v1/agents/sessions \
  -H "Authorization: Bearer $AGENT_API_TOKEN" \
  -H 'OpenAI-Beta: agents=v1' -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: task-123-session' \
  -d '{"agent":{"model":"coding"},"environment":{"type":"openai_hosted"},"input":"Write /workspace/outputs/report.txt, then summarize it."}'
```

Poll `GET /v1/agents/sessions/<id>` with the same authorization header.
Retrieve `GET /v1/agents/sessions/<id>/items` and `/turns` to inspect the result.
Handle `requires_action` and `failed` explicitly; a successful HTTP submission only means the task was accepted.
SSE uses `/v1/agents/sessions/<id>/events`. Reconnecting to live SSE does not replay the full history.
`POST /cf/v1/sessions/<id>/fork` and `GET /cf/v1/sessions/<id>/events?after=<seq>` are this
implementation's extensions; see [forks](environments-and-tools.md#fork-a-session).
