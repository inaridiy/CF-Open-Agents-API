# Use the OpenAI client through a Service Binding

This is the recommended entry point when your application runs in another Cloudflare Worker.
You use the official OpenAI client while the Agent Worker owns the API, sessions, and native execution.
The complete runnable example is [examples/caller](../examples/caller/src/index.ts).

## Bind the service

Deploy/configure the [Agent Worker](deployment.md), then add this to the caller's Wrangler configuration:

```jsonc
{
  "services": [{ "binding": "AGENTS", "service": "cf-open-agents-api" }],
}
```

For local development, follow the [README walkthrough](../README.md#try-the-complete-worker-example).
`pnpm dev:caller` starts both Worker configurations together.
The Agent Worker example disables `workers.dev` and preview URLs; its Service Binding remains usable.

Configure the same `API_TOKEN` on both Workers for the example's single-tenant authenticator.
It must contain at least 32 unpredictable characters.
The provider's `OPENAI_API_KEY` belongs only on the Agent Worker.

## Connect the official client

```ts
import OpenAI from "openai";

interface Env {
  AGENTS: Fetcher;
  API_TOKEN: string;
}
function agentClient(env: Env) {
  return new OpenAI({
    apiKey: env.API_TOKEN,
    baseURL: "https://agents.internal/v1",
    fetch: (input, init) => env.AGENTS.fetch(new Request(input, init)),
  });
}
```

The custom `fetch` sends the request to the binding, including its path, headers, body and abort signal.
There is no DNS lookup for `agents.internal`.
The request still passes through the Agent Worker's HTTP authentication and validation.
For a multi-tenant application, replace `bearerTenant` with an authenticator that derives the tenant from verified credentials.

## Run a turn and read its result

Inside your Worker handler, create an idle session, then subscribe and submit input together:

```ts
const client = agentClient(env);
const session = await client.beta.agents.sessions.create(
  {
    agent: { model: "coding" },
    environment: { type: "openai_hosted" },
  },
  { headers: { "Idempotency-Key": "session-for-task-123" } },
);

let answer = "";
for await (const event of client.beta.agents.sessions.stream(session.id, {
  input: "Create /workspace/outputs/report.txt and summarize its contents.",
  idempotencyKey: "task-123-turn-1",
})) {
  if (event.type === "agent.session.turn.output_text.delta") answer += event.delta;
  if (event.type === "agent.session.turn.failed" && !event.turn.subagent_id)
    throw new Error("Turn failed");
  if (event.type === "agent.session.turn.cancelled" && !event.turn.subagent_id)
    throw new Error("Turn cancelled");
}
return Response.json({ session_id: session.id, answer });
```

Keep the session ID for subsequent turns.
Call `sessions.stream` again with a new input and idempotency key after the session returns to idle.
Streaming does not extend the lifetime of an unrelated Worker request: forward the stream to your client or wait for the result within your handler.
For detached jobs, submit input, return the session ID, and retrieve results in a later request.

The polling example returns the first 100 items and most recent 100 turns with pagination information.
For complete history, iterate `client.beta.agents.sessions.items.list(session.id)`; the SDK fetches subsequent pages.
A dropped stream does not cancel the task. Retrieve the session/items/turns before deciding whether to submit anything again.
The `/cf/v1` event replay extension is described in [compatibility](compatibility.md).

## Function tools

Provide application tools in `agent.tools` when creating the session.
The SDK stream helper can execute named handlers and submit their results:

```ts
const clockSession = await client.beta.agents.sessions.create({
  agent: {
    model: "coding",
    tools: [
      {
        type: "function",
        name: "get_time",
        description: "Read the current UTC time",
        parameters: { type: "object", properties: {}, additionalProperties: false },
      },
    ],
  },
  environment: { type: "none" },
});
for await (const event of client.beta.agents.sessions.stream(clockSession.id, {
  input: "Use get_time to tell me the current UTC time.",
  idempotencyKey: "clock-turn-1",
  toolHandlers: { get_time: () => ({ utc: new Date().toISOString() }) },
})) {
  if (event.type === "agent.session.turn.output_text.delta") console.log(event.delta);
}
```

Without a handler, inspect `session.required_actions` when status becomes `requires_action`.
For each function call, send its exact `call_id` and `turn_id`:

```ts
await client.beta.agents.sessions.events.create(
  session.id,
  {
    events: [
      {
        type: "agent.session.input.tool_result",
        call_id: action.call_id,
        turn_id: action.turn_id,
        success: true,
        output: JSON.stringify(result),
      },
    ],
  },
  { headers: { "Idempotency-Key": `result-${action.call_id}` } },
);
```

Authenticate and authorize application tool operations in your own code.
See [tool definitions](extending.md#tools-and-assets) and the [compatibility matrix](compatibility.md).

For environment files, artifacts, MCP credentials and subagent configuration, see
[environments, tools, subagents and forks](environments-and-tools.md).

## Cancel and delete

```ts
await client.beta.agents.sessions.events.create(session.id, {
  events: [{ type: "agent.session.input.cancel" }],
});
// Retrieve until the native turn has stopped, then:
await client.beta.agents.sessions.delete(session.id);
```

Deletion requires an inactive session.
Download needed artifacts before deleting; see [retention](deployment.md#checkpoint-operations).
