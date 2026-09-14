# Call the Worker directly over RPC

Use RPC when your caller is a trusted Cloudflare Worker and you prefer library types over an HTTP client.
For the official OpenAI SDK, start with the [Service Binding guide](service-binding.md).
Both paths use the same session implementation and idempotency records.

## Binding and types

Configure the same `AGENTS` Service Binding shown in the recommended guide.
Import the public contract from the Cloudflare entry point:

```ts
import type { AgentRPC } from "cf-open-agents-api/cloudflare";
interface Env {
  AGENTS: Fetcher & AgentRPC;
}
```

When the caller can import the deployment's Worker class, Cloudflare's `Service<AgentWorker>` type also describes its binding.
The standalone `AgentRPC` interface avoids a dependency on deployment source.

RPC bypasses the HTTP authenticator.
Your caller must authenticate its own users and derive the tenant ID from that verified identity.
Do not forward an arbitrary tenant ID supplied in a request body.
The service still checks session ownership within that tenant.

## Create, submit, and retrieve

```ts
const tenant = authenticatedUser.tenantId;
const session = await env.AGENTS.createSession(
  tenant,
  {
    agent: { model: "coding" },
    environment: { type: "openai_hosted" },
  },
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

In a later request, use the same authenticated tenant:

```ts
const session = await env.AGENTS.retrieveSession(tenant, sessionId);
const items = await env.AGENTS.listItems(tenant, sessionId, { order: "asc", limit: 100 });
const turns = await env.AGENTS.listTurns(tenant, sessionId);
return Response.json({ session, items, turns });
```

`in_progress` means execution continues; `requires_action` needs a function result; `failed` includes a session error.
After `idle`, inspect the turn's status to distinguish successful completion from cancellation.
`retrieveTurn(tenant, sessionId, turnId)` retrieves one turn.

Page queries default to 20 records in descending order.
Pass `after: page.last_id` while `page.has_more` is true; limits range from 1 to 100.
`listSessions` also accepts `agent_id` to select sessions created from a saved agent.

## Errors, cancellation, and cleanup

Expected failures reject with a structured error name preserved by Workers RPC.
Use the library's `remoteApiError(error)` to reconstruct status/code in a caller that needs an HTTP response.
See [the executable caller](../examples/caller/src/index.ts) for that boundary.

Cancel with `submitEvents(tenant, sessionId, [{ type: "agent.session.input.cancel" }])`.
Retrieve until the turn stops, then call `deleteSession(tenant, sessionId)`.
Reusing an idempotency key with different input returns a conflict.
After a `failed` session with `outcome_unknown`, continue with
`forkSession(tenant, sessionId, { agent: { model: "claude" } }, "task-123-fork")`;
omit `agent` to stay on the same preset.

The direct RPC surface covers session execution and result retrieval.
Use binding HTTP for the remaining official resources; [library API](library-api.md) lists the methods explicitly.
