import { WorkerEntrypoint } from "cloudflare:workers";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { CatalogObject, Reservation } from "./catalog.js";
import { agentResource } from "./catalog.js";
import type {
  Agent,
  AgentSession,
  CreateSession,
  InputEvent,
  ListPage,
  PageQuery,
} from "./protocol.js";
import {
  ApiError,
  agentConfigSchema,
  COMPATIBILITY,
  canonicalJSON,
  createSessionSchema,
  eventsSchema,
  identifier,
  inputMessages,
  metadataSchema,
  pageSchema,
  parse,
  type RpcResult,
  remoteApiError,
  savedAgentSchema,
  unwrap,
} from "./protocol.js";
import type { ServiceOptions } from "./runtime.js";
import type { SessionRecord } from "./session.js";
import { SessionObject } from "./session.js";

export interface AgentBindings {
  SESSIONS: DurableObjectNamespace<SessionObject>;
  CATALOG: DurableObjectNamespace<CatalogObject>;
}
export interface AgentRPC {
  createSession(tenant: string, parameters: CreateSession, key?: string): Promise<AgentSession>;
  retrieveSession(tenant: string, id: string): Promise<AgentSession>;
  submitEvents(tenant: string, id: string, events: InputEvent[], key?: string): Promise<void>;
  listSessions(tenant: string, query: PageQuery): Promise<ListPage<AgentSession>>;
}
export interface AgentServiceClasses<Env> {
  AgentWorker: new (ctx: ExecutionContext, env: Env) => WorkerEntrypoint<Env> & AgentRPC;
  SessionDO: new (ctx: DurableObjectState, env: Env) => SessionObject<Env>;
}

/** One composition root configures both the API and the authoritative SessionDO. */
export function createAgentService<Env extends AgentBindings>(
  options: ServiceOptions<Env>,
): AgentServiceClasses<Env> {
  class SessionDO extends SessionObject<Env> {
    protected override dependencies() {
      return {
        drivers: options.harnesses(this.env),
        maxTurnMs: options.maxTurnMs ?? 15 * 60_000,
        pollIntervalMs: options.pollIntervalMs ?? 1_000,
      };
    }
  }
  class AgentWorker extends WorkerEntrypoint<Env> implements AgentRPC {
    private catalog(tenant: string) {
      if (!tenant || tenant.length > 256)
        throw new ApiError(
          400,
          "invalid_tenant",
          "Tenant must be nonempty and at most 256 characters",
        );
      return this.env.CATALOG.getByName(tenant);
    }
    private async session(tenant: string, id: string) {
      if (!(await this.catalog(tenant).owns(id)))
        throw new ApiError(404, "not_found", "Session not found");
      return this.env.SESSIONS.getByName(JSON.stringify([tenant, id]));
    }
    private validateModel(model: string, tools: number, sandbox: boolean) {
      const registration = options.agents[model];
      const driver = registration && options.harnesses(this.env)[registration.harness];
      if (!registration || !driver)
        throw new ApiError(422, "unsupported_model", "Model is not registered in this deployment");
      if (
        (tools > 0 && !driver.capabilities.functions) ||
        (sandbox && !driver.capabilities.sandbox)
      )
        throw new ApiError(
          422,
          "unsupported_capability",
          "The selected harness does not support this configuration",
        );
      return { registration, driver };
    }
    async createSession(
      tenant: string,
      parameters: CreateSession,
      idempotencyKey = identifier("key"),
    ): Promise<AgentSession> {
      const input = parse(createSessionSchema, parameters);
      const catalog = this.catalog(tenant);
      const saved: Agent | undefined = input.agent_id
        ? await catalog.agent(input.agent_id)
        : undefined;
      const agent = parse(agentConfigSchema, {
        ...(saved
          ? { model: saved.model, instructions: saved.instructions, tools: saved.tools }
          : {}),
        ...input.agent,
      });
      const { registration, driver } = this.validateModel(
        agent.model,
        agent.tools?.length ?? 0,
        input.environment.type !== "none",
      );
      const resource = agentResource({
        ...agent,
        name: saved?.name,
        tools: (agent.tools ?? []).map((tool) => ({ ...tool, defer_loading: false })),
      });
      if (saved) resource.id = saved.id;
      const now = Math.floor(Date.now() / 1_000);
      const session: AgentSession = {
        id: identifier("sess"),
        object: "agent.session",
        agent: {
          id: resource.id,
          instructions: resource.instructions,
          model: resource.model,
          name: resource.name,
          multi_agent: resource.multi_agent,
          reasoning: resource.reasoning,
          service_tier: resource.service_tier,
          text: resource.text,
          tools: (agent.tools ?? []).map((tool) => ({ ...tool, defer_loading: false })),
        },
        created_at: now,
        last_active_at: now,
        status: "idle",
        error: null,
        required_actions: [],
        metadata: input.metadata ?? {},
        usage: null,
        vault_ids: [],
        environment:
          input.environment.type === "none"
            ? { type: "none" }
            : {
                type: "openai_hosted",
                id: identifier("env"),
                capability_directories: [],
                files: [],
                plugins: [],
                skills: [],
                network: { access: "enabled", allowed_domains: [] },
                packages: { npm: [], python: [], system: [] },
              },
      };
      const record: SessionRecord = {
        tenant,
        session,
        agent,
        driver: driver.name,
        revision: driver.revision,
        model: registration.model,
        generation: 0,
        checkpoint: null,
        execution: null,
        cursor: 0,
        phase: "idle",
        deleted: false,
      };
      const reservation = unwrap(
        JSON.parse(
          await catalog.reserve(idempotencyKey, canonicalJSON(input), record),
        ) as RpcResult<Reservation>,
      );
      const stub = this.env.SESSIONS.getByName(JSON.stringify([tenant, reservation.id]));
      if (reservation.ready) return stub.retrieve();
      await stub.initialize(reservation.record);
      if (input.input)
        unwrap(
          await stub.submit(
            [{ type: "agent.session.input.message", input: inputMessages(input.input) }],
            `${idempotencyKey}:initial`,
          ),
        );
      await catalog.commit(idempotencyKey);
      return stub.retrieve();
    }
    async retrieveSession(tenant: string, id: string): Promise<AgentSession> {
      return (await this.session(tenant, id)).retrieve();
    }
    async submitEvents(tenant: string, id: string, events: InputEvent[], key = identifier("key")) {
      const parsed = parse(eventsSchema, { events });
      unwrap(await (await this.session(tenant, id)).submit(parsed.events, key));
    }
    async listSessions(tenant: string, query: PageQuery): Promise<ListPage<AgentSession>> {
      const page = await this.catalog(tenant).sessions(parse(pageSchema, query));
      return {
        ...page,
        data: await Promise.all(page.data.map(({ id }) => this.retrieveSession(tenant, id))),
      };
    }
    override async fetch(request: Request): Promise<Response> {
      const app = new Hono<{ Variables: { tenant: string } }>();
      app.use(
        "*",
        bodyLimit({
          maxSize: 2_000_000,
          onError: () => {
            throw new ApiError(413, "body_too_large", "Request exceeds 2 MB");
          },
        }),
      );
      app.use("*", async (c, next) => {
        const tenant = await options.authenticate(c.req.raw, this.env);
        if (!tenant) throw new ApiError(401, "unauthorized", "Authentication required");
        c.set("tenant", tenant);
        await next();
      });
      app.onError((error) => {
        const known =
          error instanceof SyntaxError
            ? new ApiError(400, "invalid_json", "Request body must be valid JSON")
            : remoteApiError(error);
        if (!known) console.error("Agent API request failed", { message: error.message });
        return Response.json(
          {
            error: {
              message: known ? known.message : "Internal server error",
              type: known ? "invalid_request_error" : "server_error",
              code: known ? known.code : "internal_error",
              param: null,
            },
          },
          { status: known ? known.status : 500 },
        );
      });
      app.get("/cf/v1/capabilities", () =>
        Response.json({
          ...COMPATIBILITY,
          agents: options.agents,
          harnesses: Object.fromEntries(
            Object.values(options.harnesses(this.env)).map((driver) => [
              driver.name,
              { revision: driver.revision, ...driver.capabilities },
            ]),
          ),
          extensions: ["event_replay"],
          hosted_environment_provider: "cloudflare",
        }),
      );
      app.post("/v1/agents/sessions", async (c) => {
        const input = parse(createSessionSchema, await c.req.json());
        const session = await this.createSession(
          c.get("tenant"),
          input,
          c.req.header("Idempotency-Key"),
        );
        return input.stream
          ? await (await this.session(c.get("tenant"), session.id)).stream(0)
          : Response.json(session);
      });
      app.get("/v1/agents/sessions", async (c) =>
        Response.json(await this.listSessions(c.get("tenant"), parse(pageSchema, c.req.query()))),
      );
      app.get("/v1/agents/sessions/:id", async (c) =>
        Response.json(await this.retrieveSession(c.get("tenant"), c.req.param("id"))),
      );
      app.post("/v1/agents/sessions/:id", async (c) => {
        const input = parse(z.strictObject({ metadata: metadataSchema }), await c.req.json());
        const stub = await this.session(c.get("tenant"), c.req.param("id"));
        return Response.json(
          input.metadata === undefined
            ? await stub.retrieve()
            : await stub.update(input.metadata ?? {}),
        );
      });
      app.delete("/v1/agents/sessions/:id", async (c) => {
        const result = await (await this.session(c.get("tenant"), c.req.param("id"))).delete();
        await this.catalog(c.get("tenant")).deleteSession(result.id);
        return Response.json(result);
      });
      app.post("/v1/agents/sessions/:id/events", async (c) => {
        const input = parse(eventsSchema, await c.req.json());
        await this.submitEvents(
          c.get("tenant"),
          c.req.param("id"),
          input.events,
          c.req.header("Idempotency-Key"),
        );
        return c.body(null, 204);
      });
      app.get(
        "/v1/agents/sessions/:id/events",
        async (c) => await (await this.session(c.get("tenant"), c.req.param("id"))).stream(),
      );
      app.get("/cf/v1/sessions/:id/events", async (c) => {
        const after = parse(z.coerce.number().int().min(0), c.req.query("after") ?? "0");
        return Response.json(
          await (await this.session(c.get("tenant"), c.req.param("id"))).replay(after),
        );
      });
      app.get("/v1/agents/sessions/:id/items", async (c) =>
        Response.json(
          await (await this.session(c.get("tenant"), c.req.param("id"))).items(
            parse(pageSchema, c.req.query()),
          ),
        ),
      );
      app.get("/v1/agents/sessions/:id/turns", async (c) =>
        Response.json(
          await (await this.session(c.get("tenant"), c.req.param("id"))).turns(
            parse(pageSchema, c.req.query()),
          ),
        ),
      );
      app.get("/v1/agents/sessions/:id/turns/:turn", async (c) =>
        Response.json(
          await (await this.session(c.get("tenant"), c.req.param("id"))).turn(c.req.param("turn")),
        ),
      );
      app.post("/v1/agents", async (c) => {
        const input = parse(savedAgentSchema, await c.req.json());
        this.validateModel(input.model, input.tools?.length ?? 0, false);
        return Response.json(
          await this.catalog(c.get("tenant")).saveAgent(
            agentResource({
              ...input,
              tools: (input.tools ?? []).map((tool) => ({ ...tool, defer_loading: false })),
            }),
            c.req.header("Idempotency-Key") ?? identifier("key"),
          ),
        );
      });
      app.get("/v1/agents", async (c) =>
        Response.json(await this.catalog(c.get("tenant")).agents(parse(pageSchema, c.req.query()))),
      );
      app.get("/v1/agents/:id", async (c) =>
        Response.json(await this.catalog(c.get("tenant")).agent(c.req.param("id"))),
      );
      app.delete("/v1/agents/:id", async (c) =>
        Response.json(await this.catalog(c.get("tenant")).deleteAgent(c.req.param("id"))),
      );
      app.notFound(() =>
        Response.json(
          {
            error: {
              code: "unsupported_endpoint",
              type: "invalid_request_error",
              message: "Endpoint is not part of this deployment's compatibility profile",
              param: null,
            },
          },
          { status: 404 },
        ),
      );
      return app.fetch(request);
    }
  }
  return { AgentWorker, SessionDO };
}

/** Static single-tenant example auth. Production can inject Access/JWT verification. */
export async function bearerTenant(
  request: Request,
  token: string | undefined,
  tenant: string,
): Promise<string | null> {
  if (!token || token.length < 32) return null;
  const supplied = request.headers.get("authorization") ?? "";
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(token),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(`Bearer ${token}`));
  return (await crypto.subtle.verify("HMAC", key, signature, encoder.encode(supplied)))
    ? tenant
    : null;
}
