import { ApiError, createSessionSchema, parse, remoteApiError } from "cf-open-agents-api";
import { type AgentRPC, bearerTenant } from "cf-open-agents-api/cloudflare";
import { WorkerEntrypoint } from "cloudflare:workers";
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
    const api = agentClient(this.env);
    try {
      return await this.route(request, tenant, match[1] === "sdk", match[2], api);
    } catch (error) {
      return errorResponse(error);
    }
  }

  private async route(
    request: Request,
    tenant: string,
    sdk: boolean,
    id: string | undefined,
    api: OpenAI,
  ): Promise<Response> {
    if (request.method === "POST" && !id) return this.create(request, tenant, sdk, api);
    if (request.method === "GET" && !id) return this.list(tenant, sdk, api);
    if (request.method === "GET" && id) return this.retrieve(tenant, sdk, id, api);
    if (request.method === "DELETE" && id) return this.remove(tenant, sdk, id, api);
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  private async create(
    request: Request,
    tenant: string,
    sdk: boolean,
    api: OpenAI,
  ): Promise<Response> {
    const input = parse(createSessionSchema, await request.json());
    if (input.stream)
      throw new ApiError(400, "invalid_request", "This polling example accepts stream: false");
    const key = request.headers.get("Idempotency-Key") ?? crypto.randomUUID();
    const parameters = {
      ...input,
      stream: false as const,
    };
    const sessions = api.beta.agents.sessions;
    const session = sdk
      ? await sessions.create(parameters, { headers: { "Idempotency-Key": key } })
      : await this.env.AGENTS.createSession(tenant, parameters, key);
    return Response.json(session, { status: 202 });
  }

  private async list(tenant: string, sdk: boolean, api: OpenAI): Promise<Response> {
    const sessions = api.beta.agents.sessions;
    const page = sdk ? await sessions.list() : await this.env.AGENTS.listSessions(tenant);
    return Response.json({ object: "list", data: page.data, has_more: page.has_more });
  }

  private async retrieve(tenant: string, sdk: boolean, id: string, api: OpenAI): Promise<Response> {
    const sessions = api.beta.agents.sessions;
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

  private async remove(tenant: string, sdk: boolean, id: string, api: OpenAI): Promise<Response> {
    const sessions = api.beta.agents.sessions;
    return Response.json(
      sdk ? await sessions.delete(id) : await this.env.AGENTS.deleteSession(tenant, id),
    );
  }
}

function errorResponse(error: unknown): Response {
  if (error instanceof SyntaxError)
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  if (error instanceof OpenAI.APIError)
    return Response.json(
      { error: error.message },
      { status: (error.status as number | undefined) ?? 502 },
    );
  const known = error instanceof Error ? remoteApiError(error) : undefined;
  return Response.json(
    { error: known?.message ?? "Agent request failed" },
    { status: known?.status ?? 500 },
  );
}
