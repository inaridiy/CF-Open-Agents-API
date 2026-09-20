# Call the Worker directly over RPC

Use RPC when your caller is a trusted Cloudflare Worker and you prefer library types over an HTTP client. For the official OpenAI SDK, start with the [Service Binding guide](service-binding.md). Both paths use the same session implementation and idempotency records. Running any harness needs this repository's Docker images; see [deployment](deployment.md).

## Binding and types

Configure the same `AGENTS` Service Binding as in the Service Binding guide, then import the public contract from the Cloudflare entrypoint:

```ts
import type { AgentRPC } from "cf-open-agents-api/cloudflare";
interface Env {
  AGENTS: Fetcher & AgentRPC;
}
```

When the caller can import the deployment's Worker class, Cloudflare's `Service<AgentWorker>` also types the binding. The standalone `AgentRPC` interface avoids a dependency on deployment source.

RPC bypasses the HTTP authenticator. Your caller must authenticate its own users and derive the tenant ID from that verified identity. Never forward a tenant ID from a request body. The service still checks session ownership within the tenant.

`fetchAs(tenant, request)` is the RPC method behind the recommended client setup: it serves one HTTP request of the Agents API as `tenant` without the authenticator. The official OpenAI client uses it through `tenantFetch(env.AGENTS, tenant)` from `cf-open-agents-api/cloudflare` (`fetch: tenantFetch(env.AGENTS, tenant)`), which strips the SDK's `AbortSignal` before the request crosses the RPC boundary and honors it on the caller's side, and can then stream, upload files or list artifacts over the binding without a bearer token. Call `fetchAs` directly only with a hand-built `Request` that has no signal. The [Service Binding guide](service-binding.md#connect-the-official-client) shows the client; the methods below return typed objects instead.

## Create, submit and retrieve

```ts
const tenant = authenticatedUser.tenantId;
const session = await env.AGENTS.createSession(
  tenant,
  { agent: { model: "codex" }, environment: { type: "openai_hosted" } },
  "task-123-session",
);
await env.AGENTS.submitEvents(
  tenant,
  session.id,
  [
    {
      type: "agent.session.input.message",
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: "Create a report in /workspace/outputs." }],
        },
      ],
    },
  ],
  "task-123-input",
);
return Response.json({ session_id: session.id });
```

In a later request, with the same authenticated tenant:

```ts
const session = await env.AGENTS.retrieveSession(tenant, sessionId);
const items = await env.AGENTS.listItems(tenant, sessionId, { order: "asc", limit: 100 });
const turns = await env.AGENTS.listTurns(tenant, sessionId);
return Response.json({ session, items, turns });
```

`in_progress` means execution continues; `requires_action` needs a function result; `failed` means an indeterminate outcome and includes `session.error`. After `idle`, read the latest turn's `status` and `error` to distinguish completion from cancellation or an ordinary failure. `retrieveTurn(tenant, sessionId, turnId)` retrieves one turn.

Page queries default to 20 records in descending order. Pass `after: page.last_id` while `page.has_more` is true; `limit` is 1 to 100. `listSessions` also accepts `agent_id`.

## Errors, cancellation and cleanup

Expected failures reject with an `Error` whose `name` encodes the status and code (`AgentApiError:409:active_turn`), which Workers RPC preserves. Use `remoteApiError(error)` from the root import to turn it back into an `ApiError` when the caller needs an HTTP response; the [example caller](../examples/caller/src/index.ts) shows that boundary.

Cancel with `submitEvents(tenant, sessionId, [{ type: "agent.session.input.cancel" }])`. Retrieve until the turn stops, then call `deleteSession(tenant, sessionId)`; deletion needs an inactive session. Reusing an idempotency key with different input rejects with `idempotency_conflict`. After a `failed` session, continue with `forkSession(tenant, sessionId, { agent: { model: "claude" } }, "task-123-fork")`; omit `agent` to stay on the same preset.

The typed methods cover session execution and result retrieval. Streaming and the other resources go through the OpenAI client with `tenantFetch`; the [library API](library-api.md#session-rpc-methods) lists every method.
