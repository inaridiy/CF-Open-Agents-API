import { WorkerEntrypoint } from "cloudflare:workers";
import { Effect } from "effect";
import type { Hono } from "hono";

import type { CatalogObject, Reservation } from "./catalog.js";
import { agentResource, ReservationResult, ReserveResult } from "./catalog.js";
import { attempt, io, runPromise } from "./effect.js";
import {
  type HostedConfiguration,
  hostedConfigurationSchema,
  publicHostedConfiguration,
} from "./environment-config.js";
import type { EnvironmentSpec } from "./environments.js";
import {
  CapabilityUnsupported,
  decodeRpc,
  EnvironmentDriverUnavailable,
  InvalidTenant,
  SessionNotFound,
} from "./errors.js";
import { buildApplication } from "./http/app.js";
import type { RouteEnv, WorkerAccess } from "./http/context.js";
import type {
  Agent,
  AgentSession,
  AgentSessionItem,
  CreateSession,
  ForkSession,
  InputEvent,
  ListPage,
  PageQuery,
  Turn,
} from "./protocol.js";
import {
  agentConfigSchema,
  canonicalJSON,
  createSessionSchema,
  eventsSchema,
  forkSessionSchema,
  identifier,
  inputMessages,
  pageSchema,
  parseEffect,
  sessionPageSchema,
} from "./protocol.js";
import type { ServiceOptions } from "./runtime.js";
import {
  checkInputImages,
  hasImageInput,
  validateMcp,
  validateModel,
} from "./service-validation.js";
import {
  type Catalog,
  configuresCapabilities,
  forkedCheckpoint,
  forkedEnvironment,
  hostedConfiguration,
  newSessionRecord,
  publicEnvironmentFiles,
  resolveInputFiles,
  resolveSkills,
  savedAgentConfig,
} from "./session-reservation.js";
import { ForkSourceResult, SessionObject, SubmitResult } from "./session.js";

export interface AgentBindings {
  SESSIONS: DurableObjectNamespace<SessionObject>;
  CATALOG: DurableObjectNamespace<CatalogObject>;
}
export interface AgentRPC {
  /**
   * Serve one HTTP request of the Agents API as `tenant`, skipping the HTTP authenticator:
   * the trusted caller already knows who it acts for, like the other RPC methods. Hand it
   * to the official client as its `fetch` and no bearer token is needed over the binding.
   */
  fetchAs(tenant: string, request: Request): Promise<Response>;
  createSession(tenant: string, parameters: CreateSession, key?: string): Promise<AgentSession>;
  /** `/cf/v1` extension: continue a session's committed state, optionally on another runtime. */
  forkSession(
    tenant: string,
    id: string,
    parameters?: ForkSession,
    key?: string,
  ): Promise<AgentSession>;
  retrieveSession(tenant: string, id: string): Promise<AgentSession>;
  submitEvents(tenant: string, id: string, events: InputEvent[], key?: string): Promise<void>;
  listSessions(
    tenant: string,
    query?: Partial<PageQuery> & { agent_id?: string },
  ): Promise<ListPage<AgentSession>>;
  listItems(
    tenant: string,
    id: string,
    query?: Partial<PageQuery>,
  ): Promise<ListPage<AgentSessionItem>>;
  listTurns(tenant: string, id: string, query?: Partial<PageQuery>): Promise<ListPage<Turn>>;
  retrieveTurn(tenant: string, id: string, turnId: string): Promise<Turn>;
  deleteSession(
    tenant: string,
    id: string,
  ): Promise<{
    id: string;
    object: "agent.session.deleted";
    deleted: true;
  }>;
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
        agents: options.agents,
        maxTurnMs: options.maxTurnMs ?? 15 * 60_000,
        pollIntervalMs: options.pollIntervalMs ?? 5_000,
      };
    }
  }
  class AgentWorker extends WorkerEntrypoint<Env> implements AgentRPC {
    private catalog(tenant: string) {
      if (!tenant || tenant.length > 256) throw new InvalidTenant();
      return this.env.CATALOG.getByName(tenant);
    }
    private session(tenant: string, id: string) {
      // lint: entrypoint
      return runPromise(
        Effect.gen(this, function* () {
          if (!(yield* io("api.session", () => this.catalog(tenant).owns(id))))
            return yield* new SessionNotFound();
          return this.env.SESSIONS.getByName(JSON.stringify([tenant, id]));
        }),
      );
    }
    /** Large bodies are compared by digest so the reservation row stays small. */
    private fingerprint(value: unknown) {
      return Effect.gen(function* () {
        const canonical = canonicalJSON(value);
        if (canonical.length < 500_000) return canonical;
        const digest = yield* io("api.fingerprint", () =>
          crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical)),
        );
        return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
      });
    }
    /** Shared tail of creation and forking: initialize, prepare, submit input, commit. */
    private establish(
      tenant: string,
      idempotencyKey: string,
      reservation: Reservation,
      initialInput: CreateSession["input"],
    ) {
      return Effect.gen(this, function* () {
        const catalog = this.catalog(tenant);
        const stub = this.env.SESSIONS.getByName(JSON.stringify([tenant, reservation.id]));
        // The commit makes the session discoverable after its object already exists; an
        // interrupt must not leave that step unknown for the retry to sort out.
        const commit = Effect.uninterruptible(
          io("api.createSession", () => catalog.commit(idempotencyKey)),
        );
        if (reservation.ready) return yield* io("api.createSession", () => stub.retrieve());
        yield* io("api.createSession", () => stub.initialize(reservation.record));
        const environmentSpec = reservation.record.environmentSpec;
        if (environmentSpec) {
          yield* io("api.environment.register", () => catalog.registerEnvironment(environmentSpec));
          const environments = options.environments?.(this.env);
          if (!environments) return yield* new EnvironmentDriverUnavailable();
          yield* io("api.environment.pending", () => stub.environmentStatus("pending"));
          const prepared = yield* environments.prepare(environmentSpec).pipe(Effect.either);
          if (prepared._tag === "Left") {
            yield* io("api.environment.failed", () => stub.environmentStatus("failed"));
            yield* commit;
            return yield* io("api.createSession", () => stub.retrieve());
          }
          yield* io("api.environment.connected", () => stub.environmentStatus("connected"));
        }
        if (initialInput)
          yield* decodeRpc(SubmitResult)(
            yield* io<typeof SubmitResult.Encoded>("api.createSession", () =>
              stub.submit(
                [{ type: "agent.session.input.message", input: inputMessages(initialInput) }],
                `${idempotencyKey}:initial`,
              ),
            ),
          );
        yield* commit;
        return yield* io("api.createSession", () => stub.retrieve());
      });
    }
    /**
     * The spec of a hosted environment, with its configuration written to R2, or nothing
     * for a plain session. A configured environment needs both the driver and the bucket.
     */
    private hostedEnvironmentSpec(
      type: CreateSession["environment"]["type"],
      identity: Pick<EnvironmentSpec, "sessionId" | "inputFiles" | "skills"> & {
        environmentId: string;
      },
      configured: HostedConfiguration,
    ) {
      return Effect.gen(this, function* () {
        const environmentSpec: EnvironmentSpec | undefined =
          type === "openai_hosted" && options.environments && options.objects
            ? {
                id: identity.environmentId,
                sessionId: identity.sessionId,
                configuration: `environments/${identity.sessionId}/configuration.json`,
                inputFiles: identity.inputFiles,
                skills: identity.skills,
              }
            : undefined;
        if (type === "openai_hosted" && Object.keys(configured).length && !environmentSpec)
          return yield* new CapabilityUnsupported({ capability: "configured_environment" });
        if (environmentSpec)
          yield* io("api.environment.config", async () => {
            await options
              .objects?.(this.env)
              .put(environmentSpec.configuration, JSON.stringify(configured));
          });
        return environmentSpec;
      });
    }
    /** Validate a new session and reserve its record under the idempotency key. */
    private reserveCreation(
      tenant: string,
      catalog: Catalog,
      input: CreateSession,
      idempotencyKey: string,
      fingerprint: string,
    ) {
      return Effect.gen(this, function* () {
        const agentId = input.agent_id;
        const saved: Agent | undefined = agentId
          ? yield* io("api.createSession", () => catalog.agent(agentId))
          : undefined;
        const agent = yield* parseEffect(agentConfigSchema, {
          ...savedAgentConfig(saved),
          ...input.agent,
        });
        const hosted = input.environment.type !== "none";
        const { registration, driver } = yield* validateModel(
          options,
          this.env,
          agent.model,
          agent,
          hosted,
        );
        if (hasImageInput(input.input) && !driver.capabilities.images)
          return yield* new CapabilityUnsupported({
            capability: "image_input",
            harness: driver.name,
          });
        for (const id of input.vault_ids ?? []) yield* io("api.vault", () => catalog.vault(id));
        yield* validateMcp(agent, hosted);
        const resource = agentResource({ ...agent, name: saved?.name, tools: agent.tools });
        if (saved) resource.id = saved.id;
        const sessionId = identifier("sess");
        const environmentId = identifier("env");
        const configured = yield* parseEffect(
          hostedConfigurationSchema,
          yield* hostedConfiguration(catalog, input.environment),
        );
        if (!driver.capabilities.environmentCapabilities && configuresCapabilities(configured))
          return yield* new CapabilityUnsupported({
            capability: "environment_capabilities",
            harness: driver.name,
          });
        const inputFiles = yield* resolveInputFiles(catalog, configured);
        const visible = publicHostedConfiguration(configured);
        const { resolvedSkills, installedSkills } = yield* resolveSkills(catalog, configured);
        const environmentSpec = yield* this.hostedEnvironmentSpec(
          input.environment.type,
          { sessionId, environmentId, inputFiles, skills: resolvedSkills },
          configured,
        );
        const record = newSessionRecord({
          tenant,
          sessionId,
          agentId: resource.id,
          resource,
          agent,
          driver,
          registration,
          vaultIds: input.vault_ids ?? [],
          metadata: input.metadata ?? {},
          environment:
            input.environment.type === "none"
              ? { type: "none" }
              : {
                  type: "openai_hosted",
                  id: environmentId,
                  ...visible,
                  skills: installedSkills,
                  files: publicEnvironmentFiles(configured, inputFiles),
                },
          checkpoint: null,
          ...(environmentSpec ? { environmentSpec } : {}),
        });
        return yield* decodeRpc(ReserveResult)(
          yield* io("api.createSession", () =>
            catalog.reserve(idempotencyKey, fingerprint, record),
          ),
        );
      });
    }
    createSession(
      tenant: string,
      parameters: CreateSession,
      idempotencyKey = identifier("key"),
    ): Promise<AgentSession> {
      // lint: entrypoint
      return runPromise(
        Effect.gen(this, function* () {
          const input = yield* parseEffect(createSessionSchema, parameters);
          yield* checkInputImages(input.input);
          const catalog = yield* attempt("api.catalog", () => this.catalog(tenant));
          const fingerprint = yield* this.fingerprint(input);
          const previous = yield* decodeRpc(ReservationResult)(
            yield* io("api.reservation", () => catalog.reservation(idempotencyKey, fingerprint)),
          );
          const reservation =
            previous ??
            (yield* this.reserveCreation(tenant, catalog, input, idempotencyKey, fingerprint));
          return yield* this.establish(tenant, idempotencyKey, reservation, input.input);
        }),
      );
    }
    /** Validate a fork against its source's committed state and reserve the new record. */
    private reserveFork(
      tenant: string,
      id: string,
      catalog: Catalog,
      input: ForkSession,
      idempotencyKey: string,
      fingerprint: string,
    ) {
      return Effect.gen(this, function* () {
        const sourceStub = yield* io("api.fork.session", () => this.session(tenant, id));
        const source = yield* decodeRpc(ForkSourceResult)(
          yield* io("api.fork.source", () => sourceStub.forkSource()),
        );
        const hosted = source.session.environment.type !== "none";
        const agent = yield* parseEffect(agentConfigSchema, { ...source.agent, ...input.agent });
        const { registration, driver } = yield* validateModel(
          options,
          this.env,
          agent.model,
          agent,
          hosted,
        );
        yield* validateMcp(agent, hosted);
        if (hasImageInput(input.input) && !driver.capabilities.images)
          return yield* new CapabilityUnsupported({
            capability: "image_input",
            harness: driver.name,
          });
        const vaultIds = input.vault_ids ?? source.session.vault_ids;
        for (const vaultId of vaultIds) yield* io("api.vault", () => catalog.vault(vaultId));
        if (hosted && source.environmentSpec && !(options.environments && options.objects))
          return yield* new CapabilityUnsupported({ capability: "environment_fork" });
        const checkpoint = forkedCheckpoint(source, agent, registration, driver, options.agents);
        const sessionId = identifier("sess");
        const environmentId = identifier("env");
        const environmentSpec = forkedEnvironment(source, sessionId, environmentId);
        const resource = agentResource({ ...agent, name: source.session.agent.name });
        const record = newSessionRecord({
          tenant,
          sessionId,
          agentId: input.agent ? resource.id : source.session.agent.id,
          resource,
          agent,
          driver,
          registration,
          vaultIds,
          metadata: input.metadata ?? {},
          environment:
            source.session.environment.type === "none"
              ? { type: "none" }
              : { ...source.session.environment, id: environmentId },
          checkpoint,
          ...(environmentSpec ? { environmentSpec } : {}),
          fork: {
            sessionId: source.session.id,
            lastTurnId: source.lastTurnId,
            transcript: source.transcript,
          },
        });
        return yield* decodeRpc(ReserveResult)(
          yield* io("api.forkSession", () => catalog.reserve(idempotencyKey, fingerprint, record)),
        );
      });
    }
    forkSession(
      tenant: string,
      id: string,
      parameters: ForkSession = {},
      idempotencyKey = identifier("key"),
    ): Promise<AgentSession> {
      // lint: entrypoint
      return runPromise(
        Effect.gen(this, function* () {
          const input = yield* parseEffect(forkSessionSchema, parameters);
          yield* checkInputImages(input.input);
          const catalog = yield* attempt("api.catalog", () => this.catalog(tenant));
          const fingerprint = yield* this.fingerprint({ fork: id, ...input });
          const previous = yield* decodeRpc(ReservationResult)(
            yield* io("api.reservation", () => catalog.reservation(idempotencyKey, fingerprint)),
          );
          const reservation =
            previous ??
            (yield* this.reserveFork(tenant, id, catalog, input, idempotencyKey, fingerprint));
          return yield* this.establish(tenant, idempotencyKey, reservation, input.input);
        }),
      );
    }
    retrieveSession(tenant: string, id: string): Promise<AgentSession> {
      // lint: entrypoint
      return runPromise(
        Effect.gen(this, function* () {
          const stub = yield* io("api.retrieveSession", () => this.session(tenant, id));
          return yield* io("api.retrieveSession", () => stub.retrieve());
        }),
      );
    }
    submitEvents(tenant: string, id: string, events: InputEvent[], key = identifier("key")) {
      // lint: entrypoint
      return runPromise(
        Effect.gen(this, function* () {
          const parsed = yield* parseEffect(eventsSchema, { events });
          const stub = yield* io("api.submitEvents", () => this.session(tenant, id));
          yield* decodeRpc(SubmitResult)(
            yield* io<typeof SubmitResult.Encoded>("api.submitEvents", () =>
              stub.submit(parsed.events, key),
            ),
          );
        }),
      );
    }
    listSessions(
      tenant: string,
      query: Partial<PageQuery> & { agent_id?: string } = {},
    ): Promise<ListPage<AgentSession>> {
      // lint: entrypoint
      return runPromise(
        Effect.gen(this, function* () {
          const parsed = yield* parseEffect(sessionPageSchema, query);
          const catalog = yield* attempt("api.catalog", () => this.catalog(tenant));
          const page = yield* io("api.listSessions", () => catalog.sessions(parsed));
          // The catalog page already proves ownership: every row is this tenant's, and the
          // object is addressed under the tenant, so one RPC per row reads the record.
          // A session deleted but not yet removed from discovery must not fail the page. The
          // object answers over RPC, so its `SessionNotFound` may arrive by wire name.
          const sessions = yield* Effect.forEach(
            page.data,
            ({ id }) =>
              io("api.retrieveSession", () =>
                this.env.SESSIONS.getByName(JSON.stringify([tenant, id])).retrieve(),
              ).pipe(
                Effect.catchTag("SessionNotFound", () => Effect.void),
                Effect.catchIf(
                  (error) => error._tag === "ApiError" && error.status === 404,
                  () => Effect.void,
                ),
              ),
            { concurrency: 8 },
          );
          return {
            ...page,
            data: sessions.filter((session) => session !== undefined),
          };
        }),
      );
    }
    listItems(
      tenant: string,
      id: string,
      query: Partial<PageQuery> = {},
    ): Promise<ListPage<AgentSessionItem>> {
      // lint: entrypoint
      return runPromise(
        Effect.gen(this, function* () {
          const page = yield* parseEffect(pageSchema, query);
          const stub = yield* io("api.listItems", () => this.session(tenant, id));
          return yield* io("api.listItems", () => stub.items(page));
        }),
      );
    }
    listTurns(tenant: string, id: string, query: Partial<PageQuery> = {}): Promise<ListPage<Turn>> {
      // lint: entrypoint
      return runPromise(
        Effect.gen(this, function* () {
          const page = yield* parseEffect(pageSchema, query);
          const stub = yield* io("api.listTurns", () => this.session(tenant, id));
          return yield* io("api.listTurns", () => stub.turns(page));
        }),
      );
    }
    retrieveTurn(tenant: string, id: string, turnId: string): Promise<Turn> {
      // lint: entrypoint
      return runPromise(
        Effect.gen(this, function* () {
          const stub = yield* io("api.retrieveTurn", () => this.session(tenant, id));
          return yield* io("api.retrieveTurn", () => stub.turn(turnId));
        }),
      );
    }
    deleteSession(tenant: string, id: string) {
      // lint: entrypoint
      return runPromise(
        Effect.gen(this, function* () {
          // The object is addressed directly: a retry after discovery was removed still
          // finds the deleted record or its tombstone, and a foreign tenant finds nothing.
          const catalog = yield* attempt("api.catalog", () => this.catalog(tenant));
          const stub = this.env.SESSIONS.getByName(JSON.stringify([tenant, id]));
          const result = yield* io("api.deleteSession", () => stub.delete());
          yield* io("api.deleteSession", () => catalog.deleteSession(result.id));
          yield* io("api.deleteSession", () => stub.purge());
          return result;
        }),
      );
    }
    override async fetch(request: Request): Promise<Response> {
      return application().fetch(request, this.access());
    }
    async fetchAs(tenant: string, request: Request): Promise<Response> {
      if (!tenant || tenant.length > 256) throw new InvalidTenant();
      return await application().fetch(request, this.access(tenant));
    }
    /** Route handlers reach the entrypoint through this per-request view, not through RPC. */
    private access(resolved?: string): WorkerAccess<Env> {
      return {
        env: this.env,
        ...(resolved === undefined ? {} : { tenant: resolved }),
        fetchAs: (tenant, request) => this.fetchAs(tenant, request),
        catalog: (tenant) => this.catalog(tenant),
        session: (tenant, id) => this.session(tenant, id),
        validateModel: (model, agent, sandbox) =>
          validateModel(options, this.env, model, agent, sandbox),
        createSession: (tenant, input, key) => this.createSession(tenant, input, key),
        forkSession: (tenant, id, input, key) => this.forkSession(tenant, id, input, key),
        retrieveSession: (tenant, id) => this.retrieveSession(tenant, id),
        submitEvents: (tenant, id, events, key) => this.submitEvents(tenant, id, events, key),
        listSessions: (tenant, query) => this.listSessions(tenant, query),
        listItems: (tenant, id, query) => this.listItems(tenant, id, query),
        listTurns: (tenant, id, query) => this.listTurns(tenant, id, query),
        retrieveTurn: (tenant, id, turnId) => this.retrieveTurn(tenant, id, turnId),
        deleteSession: (tenant, id) => this.deleteSession(tenant, id),
      };
    }
  }
  let cached: Hono<RouteEnv<Env>> | undefined;
  const application = () => {
    cached ??= buildApplication(options);
    return cached;
  };
  return { AgentWorker, SessionDO };
}

/**
 * A `fetch` for the official client that sends every request over the `AGENTS` binding as
 * `tenant` through `fetchAs`, so no bearer token is needed. A Request travels over RPC by
 * structured clone, which excludes its `AbortSignal`; the signal is honored on the caller's
 * side instead: while the response is pending, an abort rejects the promise with an
 * `AbortError` and the in-flight request completes on its own. Once the response has been
 * returned, a streamed body it carries is not cancelled by the signal.
 */
export function tenantFetch(agents: Pick<AgentRPC, "fetchAs">, tenant: string): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const { signal } = request;
    if (signal.aborted) throw abortReason(signal);
    const response = agents.fetchAs(
      tenant,
      new Request(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        ...(request.body ? { duplex: "half" } : {}),
      }),
    );
    const aborted = Promise.withResolvers<never>();
    const onAbort = () => aborted.reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      return await Promise.race([response, aborted.promise]);
    } finally {
      // The response won, or the abort did: either way the listener must not outlive the call.
      signal.removeEventListener("abort", onAbort);
    }
  };
}
const abortReason = (signal: AbortSignal): Error =>
  signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError");

let warnedAboutToken = false;
/** Static single-tenant example auth. Production can inject Access/JWT verification. */
export async function bearerTenant(
  request: Request,
  token: string | undefined,
  tenant: string,
): Promise<string | null> {
  if (!token || token.length < 32) {
    // Fail closed, but say why once per isolate: a missing or short API_TOKEN otherwise
    // looks like a client problem in every response.
    if (!warnedAboutToken) {
      warnedAboutToken = true;
      console.error(
        "bearerTenant: API_TOKEN is missing or shorter than 32 characters, so every request is rejected with 401. Set a random token of at least 32 characters (create-cf-open-agents-api init generates one).",
      );
    }
    return null;
  }
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
