import { WorkerEntrypoint } from "cloudflare:workers";
import { ApiError, createSessionSchema, parse, remoteApiError } from "cf-open-agents-api";
import { type AgentRPC, bearerTenant } from "cf-open-agents-api/cloudflare";
import OpenAI from "openai";

/** The example uses the API Worker's single-tenant authenticator and shared token. */
export interface CallerBindings {
  AGENTS: Fetcher & AgentRPC;
  API_TOKEN: string;
}

export function agentClient(env: Pick<CallerBindings, "AGENTS" | "API_TOKEN">): OpenAI {
  return new OpenAI({
    baseURL: "https://agents.internal/v1",
    apiKey: env.API_TOKEN,
    fetch: (input, init) => env.AGENTS.fetch(new Request(input, init)),
  });
}

/** Compare both Service Binding paths using the same session request and result. */
export default class CallerWorker extends WorkerEntrypoint<CallerBindings> {
  override async fetch(request: Request): Promise<Response> {
    const tenant = await bearerTenant(request, this.env.API_TOKEN, "default");
    if (!tenant) return Response.json({ error: "Authentication required" }, { status: 401 });
    const match = /^\/(sdk|rpc)\/sessions(?:\/(sess_[a-zA-Z0-9]+))?$/.exec(
      new URL(request.url).pathname,
    );
    if (!match)
      return Response.json({ error: "Use /sdk/sessions or /rpc/sessions" }, { status: 404 });
    const sdk = match[1] === "sdk";
    const id = match[2];
    const sessions = agentClient(this.env).beta.agents.sessions;
    try {
      if (request.method === "POST" && !id) {
        const input = parse(createSessionSchema, await request.json());
        if (input.stream)
          throw new ApiError(400, "invalid_request", "This polling example accepts stream: false");
        const key = request.headers.get("Idempotency-Key") ?? crypto.randomUUID();
        const parameters = {
          ...input,
          stream: false as const,
        };
        const session = sdk
          ? await sessions.create(parameters, { headers: { "Idempotency-Key": key } })
          : await this.env.AGENTS.createSession(tenant, parameters, key);
        return Response.json(session, { status: 202 });
      }
      if (request.method === "GET" && !id) {
        const page = sdk ? await sessions.list() : await this.env.AGENTS.listSessions(tenant);
        return Response.json({ object: "list", data: page.data, has_more: page.has_more });
      }
      if (request.method === "GET" && id) {
        const session = sdk
          ? await sessions.retrieve(id)
          : await this.env.AGENTS.retrieveSession(tenant, id);
        const items = sdk
          ? await sessions.items.list(id, { order: "asc", limit: 100 })
          : await this.env.AGENTS.listItems(tenant, id, { order: "asc", limit: 100 });
        const turns = sdk
          ? await sessions.turns.list(id, { order: "desc", limit: 100 })
          : await this.env.AGENTS.listTurns(tenant, id, { order: "desc", limit: 100 });
        return Response.json({
          session,
          items: {
            data: items.data,
            has_more: items.has_more,
            last_id: items.data.at(-1)?.id ?? null,
          },
          turns: {
            data: turns.data,
            has_more: turns.has_more,
            last_id: turns.data.at(-1)?.id ?? null,
          },
        });
      }
      if (request.method === "DELETE" && id) {
        return Response.json(
          sdk ? await sessions.delete(id) : await this.env.AGENTS.deleteSession(tenant, id),
        );
      }
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    } catch (error) {
      if (error instanceof SyntaxError)
        return Response.json({ error: "Invalid JSON" }, { status: 400 });
      if (error instanceof OpenAI.APIError)
        return Response.json({ error: error.message }, { status: error.status ?? 502 });
      const known = error instanceof Error ? remoteApiError(error) : undefined;
      return Response.json(
        { error: known?.message ?? "Agent request failed" },
        { status: known?.status ?? 500 },
      );
    }
  }
}
