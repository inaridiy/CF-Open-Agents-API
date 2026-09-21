# Use the OpenAI client through a Service Binding

This is the recommended entry point when your application runs in another Cloudflare Worker. You use the official OpenAI client while the Agent Worker owns the API, the sessions and the native execution. The complete runnable example is [examples/caller](../examples/caller/src/index.ts). Running any harness needs this repository's Docker images; see [deployment](deployment.md).

## Bind the service

Deploy or run the [Agent Worker](deployment.md), then add this to the caller's Wrangler configuration:

```jsonc
{
  "services": [{ "binding": "AGENTS", "service": "cf-open-agents-api" }],
}
```

For local development, follow the [local development walkthrough](../CONTRIBUTING.md#local-development); `pnpm dev:caller` starts both Workers together. The Agent Worker example disables `workers.dev` and preview URLs; its Service Binding still works.

When the API lives in the same Worker as your application (the setup CLI's retrofit), the binding points at the Worker itself: `{ "binding": "AGENTS", "service": "<your worker>", "entrypoint": "Agents" }`. Everything below applies unchanged; `env.AGENTS` is the same `Fetcher & AgentRPC`.

`API_TOKEN` (at least 32 unpredictable characters) is read by the example's single-tenant authenticator for HTTP callers; a Service Binding caller that uses `tenantFetch` does not need it. The provider's `OPENAI_API_KEY` belongs only on the Agent Worker.

## Connect the official client

The binding is the credential. `tenantFetch(env.AGENTS, tenant)` returns a `fetch` for the official client that serves every request as the given tenant through the binding's `fetchAs` RPC method, skipping the HTTP authenticator like the other [RPC methods](rpc.md): the trusted Worker names the tenant, and no `API_TOKEN` travels over the binding.

```ts
import { type AgentRPC, tenantFetch } from "cf-open-agents-api/cloudflare";
import OpenAI from "openai";

interface Env {
  AGENTS: Fetcher & AgentRPC;
}
function agentClient(env: Env, tenant: string) {
  return new OpenAI({
    apiKey: "service-binding", // the SDK requires a value; the API never reads it on this path
    baseURL: "https://agents.internal/v1",
    fetch: tenantFetch(env.AGENTS, tenant),
  });
}
```

The request reaches the binding with its path, headers and body; there is no DNS lookup for `agents.internal`. Use `tenantFetch` rather than calling `fetchAs` from the client's `fetch` yourself: a `Request` handed to an RPC method travels by structured clone, which cannot carry the SDK's `AbortSignal` (`DataCloneError: AbortSignal serialization is not enabled`), so `tenantFetch` builds the request without the signal and honors it on the caller's side (the promise rejects with an `AbortError`; the in-flight request completes). `env.AGENTS.fetchAs(tenant, request)` itself is fine for a hand-built request without a signal, such as `new Request("https://agents.internal/cf/v1/capabilities")`, which is how the demo reads the preset list. Validation, idempotency and session ownership within the tenant are unchanged. The same trust rule as for RPC applies: derive `tenant` from your own verified identity (the authenticated user, your service's tenant), never from a request body or header a client controls.

`examples/caller`'s `/sdk` route is built this way. When a caller only holds a token, or forwards end-user requests that must pass through the Agent Worker's own authenticator, use the binding's plain `fetch` with the bearer token instead — the second path the example exercises, directly, in its test suite:

```ts
new OpenAI({
  apiKey: env.API_TOKEN,
  baseURL: "https://agents.internal/v1",
  fetch: (input, init) => env.AGENTS.fetch(new Request(input, init)),
});
```

That request passes through `authenticate` (the example's `bearerTenant`), so both Workers need the same `API_TOKEN`. For a multi-tenant application on this path, replace `bearerTenant` with an authenticator that derives the tenant from verified credentials.

## Run a turn and read its result

Inside your Worker handler, create an idle session, then subscribe and submit input together:

```ts
const client = agentClient(env, "default");
const session = await client.beta.agents.sessions.create(
  { agent: { model: "codex" }, environment: { type: "openai_hosted" } },
  { headers: { "Idempotency-Key": "session-for-task-123" } },
);

let answer = "";
for await (const event of client.beta.agents.sessions.stream(session.id, {
  input: "Create /workspace/outputs/report.txt and summarize its contents.",
  idempotencyKey: "task-123-turn-1",
})) {
  if (event.type === "agent.session.turn.output_text.delta") answer += event.delta;
  if (event.type === "agent.session.turn.failed" && !event.turn.subagent_id)
    throw new Error(`${event.turn.error?.code}: ${event.turn.error?.message}`);
  if (event.type === "agent.session.turn.cancelled" && !event.turn.subagent_id)
    throw new Error("Turn cancelled");
}
return Response.json({ session_id: session.id, answer });
```

Keep the session ID for later turns. Call `sessions.stream` again with new input and a new idempotency key after the session returns to `idle`. A failed turn also returns the session to `idle` with `session.error` set, so a client that only looks at `status` cannot tell completion from failure; read `session.error` and the latest turn's `error`, as the [demo app](../examples/demo/src/index.tsx) does. Only an indeterminate outcome leaves the session `failed`; then you fork it. Streaming does not extend the lifetime of an unrelated Worker request: forward the stream to your client or wait for the result inside your handler. For detached jobs, submit input, return the session ID, and retrieve results in a later request.

Input sent while a turn is running steers it: the message is added to the live turn on every harness. If the runtime has already finished, the message runs as the next turn instead.

For complete history, iterate `client.beta.agents.sessions.items.list(session.id)`; the SDK follows pages. A dropped stream never cancels the task. Retrieve the session, items and turns before deciding whether to submit anything again. The `/cf/v1` event replay extension is described in the [HTTP guide](http-api.md#use-raw-http).

## Function tools

Provide application tools in `agent.tools` when creating the session. The SDK stream helper can execute named handlers and submit their results:

```ts
const clockSession = await client.beta.agents.sessions.create({
  agent: {
    model: "codex",
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

Without a handler, inspect `session.required_actions` when the status becomes `requires_action`. For each function call, send its exact `call_id` and `turn_id`:

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

Authenticate and authorize application tool operations in your own code. See [tool definitions](extending.md#tools-and-assets) and the [compatibility profile](compatibility.md).

For environment files, artifacts, MCP credentials, subagents and forks, see [environments and tools](environments-and-tools.md).

## Cancel and delete

```ts
await client.beta.agents.sessions.events.create(session.id, {
  events: [{ type: "agent.session.input.cancel" }],
});
// Retrieve until the turn has stopped, then:
await client.beta.agents.sessions.delete(session.id);
```

Deletion requires an inactive session. Download needed artifacts before deleting; see [retention](deployment.md#checkpoint-operations).
