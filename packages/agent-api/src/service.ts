import { WorkerEntrypoint } from "cloudflare:workers";
import { Effect } from "effect";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { HostedSkill } from "openai/resources/beta/agents/agents";

import { sessionTools } from "./agent-tools.js";
import type { CatalogObject, Reservation } from "./catalog.js";
import { agentResource, ReservationResult, ReserveResult } from "./catalog.js";
import { attempt, io, runPromise } from "./effect.js";
import {
  hostedConfigurationSchema,
  publicHostedConfiguration,
  type TemplateConfiguration,
} from "./environment-config.js";
import type { EnvironmentSpec } from "./environments.js";
import { mergeEnvironment } from "./environments.js";
import {
  BodyTooLarge,
  type Capability,
  CapabilityUnsupported,
  caughtFailure,
  decodeRpc,
  DelegateUnavailable,
  EnvironmentDriverUnavailable,
  ImageLimitExceeded,
  InvalidJson,
  InvalidTenant,
  isPermanent,
  McpPlacementInvalid,
  ModelNotRegistered,
  ReservedToolName,
  SessionNotFound,
  toApiError,
  Unauthorized,
} from "./errors.js";
import { INPUT_FILE_LIMIT, type ResolvedInputFile } from "./files.js";
import { registerAgentRoutes } from "./http/agents.js";
import { registerCapabilityRoutes } from "./http/capabilities.js";
import type { RouteEnv, WorkerAccess } from "./http/context.js";
import { registerEnvironmentRoutes } from "./http/environments.js";
import { registerFileRoutes } from "./http/files.js";
import { registerSessionRoutes } from "./http/sessions.js";
import { registerSkillRoutes } from "./http/skills.js";
import { registerVaultRoutes } from "./http/vaults.js";
import type {
  Agent,
  AgentConfig,
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
  IMAGE_LIMIT,
  inputMessages,
  pageSchema,
  parseEffect,
  remoteImageURLs,
  reservedDelegationName,
  sessionPageSchema,
} from "./protocol.js";
import type { ServiceOptions } from "./runtime.js";
import type { SessionRecord } from "./session.js";
import { ForkSourceResult, SessionObject, SubmitResult } from "./session.js";
import { type ResolvedSkill, SKILL_UPLOAD_LIMIT } from "./skills.js";

export interface AgentBindings {
  SESSIONS: DurableObjectNamespace<SessionObject>;
  CATALOG: DurableObjectNamespace<CatalogObject>;
}
export interface AgentRPC {
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
    /** Reject configurations the selected driver cannot execute before any state exists. */
    private validateModel(
      model: string,
      agent: {
        tools?: readonly { type: string; defer_loading?: boolean; enabled?: boolean }[] | null;
        multi_agent?: { enabled: boolean } | null;
      },
      sandbox: boolean,
    ) {
      return Effect.gen(this, function* () {
        const registration = options.agents[model];
        const driver = registration && options.harnesses(this.env)[registration.harness];
        if (!registration || !driver) return yield* new ModelNotRegistered({ alias: model });
        const tools = agent.tools ?? [];
        const unsupported = (capability: Capability) =>
          new CapabilityUnsupported({ capability, harness: driver.name });
        if (
          (tools.length > 0 && !driver.capabilities.functions) ||
          (sandbox && !driver.capabilities.sandbox)
        )
          return yield* unsupported("configuration");
        if (
          agent.multi_agent?.enabled &&
          !driver.capabilities.subagents &&
          !registration.delegates?.length
        )
          return yield* unsupported("subagents");
        if (reservedDelegationName(agent)) return yield* new ReservedToolName();
        if (agent.multi_agent?.enabled)
          for (const alias of registration.delegates ?? []) {
            const target = options.agents[alias];
            if (!target || !options.harnesses(this.env)[target.harness])
              return yield* new DelegateUnavailable({ alias });
          }
        if (tools.some((tool) => tool.type === "mcp") && !driver.capabilities.mcp)
          return yield* unsupported("mcp");
        // Hosted search needs both a runtime that drives it and a model connection that provides it.
        if (
          tools.some((tool) => tool.type === "web_search") &&
          !(driver.capabilities.webSearch && registration.webSearch === true)
        )
          return yield* unsupported("web_search");
        if (
          tools.some(
            (tool) =>
              tool.type === "tool_search" || (tool.type === "function" && tool.defer_loading),
          ) &&
          !driver.capabilities.toolSearch
        )
          return yield* unsupported("tool_search");
        if (
          tools.some(
            (tool) => tool.type === "programmatic_tool_calling" && tool.enabled !== false,
          ) &&
          !driver.capabilities.programmaticToolCalling
        )
          return yield* unsupported("programmatic_tool_calling");
        return { registration, driver };
      });
    }
    /** MCP placement rules that depend on the environment rather than the driver. */
    private validateMcp(agent: AgentConfig, hosted: boolean) {
      return Effect.gen(function* () {
        for (const tool of agent.tools ?? []) {
          if (tool.type !== "mcp") continue;
          const environmentOrigin =
            tool.transport.type === "stdio" || tool.connection_origin === "environment";
          if (environmentOrigin && !hosted)
            return yield* new McpPlacementInvalid({ rule: "environment_required" });
          if (tool.transport.type === "stdio" && tool.connection_origin === "service")
            return yield* new McpPlacementInvalid({ rule: "stdio_in_service" });
          if (
            environmentOrigin &&
            (tool.credential_id || Object.keys(tool.request_metadata ?? {}).length)
          )
            return yield* new CapabilityUnsupported({ capability: "environment_mcp_credentials" });
        }
      });
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
            (yield* Effect.gen(this, function* () {
              const agentId = input.agent_id;
              const saved: Agent | undefined = agentId
                ? yield* io("api.createSession", () => catalog.agent(agentId))
                : undefined;
              const agent = yield* parseEffect(agentConfigSchema, {
                ...(saved
                  ? {
                      model: saved.model,
                      instructions: saved.instructions,
                      tools: saved.tools,
                      multi_agent: {
                        enabled: saved.multi_agent.enabled,
                        ...(saved.multi_agent.max_concurrent_subagents != null
                          ? {
                              max_concurrent_subagents: saved.multi_agent.max_concurrent_subagents,
                            }
                          : {}),
                      },
                      reasoning: saved.reasoning,
                      text: saved.text,
                      service_tier: saved.service_tier,
                    }
                  : {}),
                ...input.agent,
              });
              const { registration, driver } = yield* this.validateModel(
                agent.model,
                agent,
                input.environment.type !== "none",
              );
              if (hasImageInput(input.input) && !driver.capabilities.images)
                return yield* new CapabilityUnsupported({
                  capability: "image_input",
                  harness: driver.name,
                });
              for (const id of input.vault_ids ?? [])
                yield* io("api.vault", () => catalog.vault(id));
              yield* this.validateMcp(agent, input.environment.type !== "none");
              const resource = agentResource({
                ...agent,
                name: saved?.name,
                tools: agent.tools,
              });
              if (saved) resource.id = saved.id;
              const now = Math.floor(Date.now() / 1_000);
              const sessionId = identifier("sess");
              const environmentId = identifier("env");
              let configuration = {};
              if (input.environment.type === "openai_hosted") {
                const {
                  type: _type,
                  environment_template_id: templateId,
                  ...inline
                } = input.environment;
                const base: TemplateConfiguration = templateId
                  ? yield* io("api.template", () => catalog.templateConfiguration(templateId))
                  : {};
                const { name: _name, ...template } = base;
                configuration = yield* attempt("api.environment.merge", () =>
                  mergeEnvironment(template, inline),
                );
              }
              const configured = yield* parseEffect(hostedConfigurationSchema, configuration);
              if (
                !driver.capabilities.environmentCapabilities &&
                (configured.skills?.length ||
                  configured.plugins?.length ||
                  configured.capability_directories?.length)
              )
                return yield* new CapabilityUnsupported({
                  capability: "environment_capabilities",
                  harness: driver.name,
                });
              const inputFiles: Record<string, ResolvedInputFile> = {};
              for (const file of configured.files ?? []) {
                if (file.type !== "file_id") continue;
                const stored = yield* io("api.file", () => catalog.file(file.file_id));
                inputFiles[file.file_id] = { key: stored.key, size: stored.resource.bytes };
              }
              const visible = publicHostedConfiguration(configured);
              const resolvedSkills: ResolvedSkill[] = [];
              const installedSkills: HostedSkill[] = [];
              for (const skill of configured.skills ?? []) {
                if (skill.type !== "skill_reference") {
                  installedSkills.push({
                    type: skill.type,
                    name: skill.name,
                    description: skill.description,
                  });
                  continue;
                }
                const stored = yield* io("api.skill.resolve", () =>
                  catalog.skillVersion(skill.skill_id, skill.version),
                );
                resolvedSkills.push({
                  skillId: skill.skill_id,
                  version: stored.resource.version,
                  name: stored.resource.name,
                  description: stored.resource.description,
                  key: stored.key,
                });
                skill.version = stored.resource.version;
                installedSkills.push({
                  type: skill.type,
                  skill_id: skill.skill_id,
                  version: stored.resource.version,
                  name: stored.resource.name,
                  description: stored.resource.description,
                });
              }
              const environmentSpec =
                input.environment.type === "openai_hosted" &&
                options.environments &&
                options.objects
                  ? {
                      id: environmentId,
                      sessionId,
                      configuration: `environments/${sessionId}/configuration.json`,
                      inputFiles,
                      skills: resolvedSkills,
                    }
                  : undefined;
              if (
                input.environment.type === "openai_hosted" &&
                Object.keys(configured).length &&
                !environmentSpec
              )
                return yield* new CapabilityUnsupported({ capability: "configured_environment" });
              if (environmentSpec)
                yield* io("api.environment.config", async () => {
                  await options
                    .objects?.(this.env)
                    .put(environmentSpec.configuration, JSON.stringify(configured));
                });
              const session: AgentSession = {
                id: sessionId,
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
                  tools: sessionTools(agent.tools ?? []),
                },
                created_at: now,
                last_active_at: now,
                status: "idle",
                error: null,
                required_actions: [],
                metadata: input.metadata ?? {},
                usage: null,
                vault_ids: input.vault_ids ?? [],
                environment:
                  input.environment.type === "none"
                    ? { type: "none" }
                    : {
                        type: "openai_hosted",
                        id: environmentId,
                        ...visible,
                        skills: installedSkills,
                        files: (configured.files ?? []).map((file) =>
                          file.type === "inline"
                            ? {
                                type: file.type,
                                id: identifier("envfile"),
                                path: file.path,
                                size_bytes: atob(file.data).length,
                              }
                            : {
                                type: file.type,
                                id: identifier("envfile"),
                                path: file.path,
                                size_bytes: inputFiles[file.file_id]?.size ?? 0,
                                file_id: file.file_id,
                              },
                        ),
                      },
              };
              const record: SessionRecord = {
                schemaVersion: 2,
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
                ...(environmentSpec ? { environmentSpec } : {}),
              };
              return yield* decodeRpc(ReserveResult)(
                yield* io("api.createSession", () =>
                  catalog.reserve(idempotencyKey, fingerprint, record),
                ),
              );
            }));
          return yield* this.establish(tenant, idempotencyKey, reservation, input.input);
        }),
      );
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
            (yield* Effect.gen(this, function* () {
              const sourceStub = yield* io("api.fork.session", () => this.session(tenant, id));
              const source = yield* decodeRpc(ForkSourceResult)(
                yield* io("api.fork.source", () => sourceStub.forkSource()),
              );
              const hosted = source.session.environment.type !== "none";
              const agent = yield* parseEffect(agentConfigSchema, {
                ...source.agent,
                ...input.agent,
              });
              const { registration, driver } = yield* this.validateModel(
                agent.model,
                agent,
                hosted,
              );
              yield* this.validateMcp(agent, hosted);
              if (hasImageInput(input.input) && !driver.capabilities.images)
                return yield* new CapabilityUnsupported({
                  capability: "image_input",
                  harness: driver.name,
                });
              const vaultIds = input.vault_ids ?? source.session.vault_ids;
              for (const vaultId of vaultIds) yield* io("api.vault", () => catalog.vault(vaultId));
              if (hosted && source.environmentSpec && !(options.environments && options.objects))
                return yield* new CapabilityUnsupported({ capability: "environment_fork" });
              const sameHarness =
                registration.harness === source.driver && driver.revision === source.revision;
              // A runtime that fixes tools at thread start cannot resume with a different tool surface.
              const surface = (config: AgentConfig, delegates: readonly string[] | undefined) =>
                canonicalJSON({
                  tools: config.tools ?? [],
                  subagents: !!config.multi_agent?.enabled,
                  delegates: config.multi_agent?.enabled ? (delegates ?? []) : [],
                });
              const retooled =
                surface(source.agent, options.agents[source.session.agent.model]?.delegates) !==
                surface(agent, registration.delegates);
              // Native history transfers only between identical harness revisions.
              const checkpoint =
                sameHarness &&
                source.checkpoint &&
                !(driver.capabilities.toolsFixedAtStart && retooled)
                  ? {
                      version: 1 as const,
                      driver: source.checkpoint.driver,
                      revision: source.checkpoint.revision,
                      native: source.checkpoint.native,
                      ...(source.checkpoint.workspace
                        ? { workspace: source.checkpoint.workspace }
                        : {}),
                      ...(source.checkpoint.environmentFileVersion !== undefined
                        ? { environmentFileVersion: source.checkpoint.environmentFileVersion }
                        : {}),
                    }
                  : null;
              const now = Math.floor(Date.now() / 1_000);
              const sessionId = identifier("sess");
              const environmentId = identifier("env");
              const environmentSpec: EnvironmentSpec | undefined = source.environmentSpec
                ? {
                    ...source.environmentSpec,
                    id: environmentId,
                    sessionId,
                    inherited: {
                      sessionId: source.session.id,
                      environmentId: source.environmentSpec.id,
                      ...(source.checkpoint?.workspace
                        ? { workspace: source.checkpoint.workspace }
                        : {}),
                    },
                  }
                : undefined;
              const resource = agentResource({ ...agent, name: source.session.agent.name });
              const session: AgentSession = {
                ...source.session,
                id: sessionId,
                agent: {
                  id: input.agent ? resource.id : source.session.agent.id,
                  instructions: resource.instructions,
                  model: resource.model,
                  name: resource.name,
                  multi_agent: resource.multi_agent,
                  reasoning: resource.reasoning,
                  service_tier: resource.service_tier,
                  text: resource.text,
                  tools: sessionTools(agent.tools ?? []),
                },
                created_at: now,
                last_active_at: now,
                status: "idle",
                error: null,
                required_actions: [],
                metadata: input.metadata ?? {},
                usage: null,
                vault_ids: vaultIds,
                environment:
                  source.session.environment.type === "none"
                    ? { type: "none" }
                    : { ...source.session.environment, id: environmentId },
              };
              const record: SessionRecord = {
                schemaVersion: 2,
                tenant,
                session,
                agent,
                driver: driver.name,
                revision: driver.revision,
                model: registration.model,
                generation: 0,
                checkpoint,
                execution: null,
                cursor: 0,
                phase: "idle",
                deleted: false,
                ...(environmentSpec ? { environmentSpec } : {}),
                ...(!checkpoint && source.transcript
                  ? { inheritedTranscript: source.transcript }
                  : {}),
                forkedFrom: { sessionId: source.session.id, turnId: source.lastTurnId },
              };
              return yield* decodeRpc(ReserveResult)(
                yield* io("api.forkSession", () =>
                  catalog.reserve(idempotencyKey, fingerprint, record),
                ),
              );
            }));
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
          // A session deleted but not yet removed from discovery must not fail the page. The
          // object answers over RPC, so its `SessionNotFound` may arrive by wire name.
          const sessions = yield* Effect.forEach(
            page.data,
            ({ id }) =>
              io("api.retrieveSession", () => this.retrieveSession(tenant, id)).pipe(
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
    /** Route handlers reach the entrypoint through this per-request view, not through RPC. */
    private access(): WorkerAccess<Env> {
      return {
        env: this.env,
        catalog: (tenant) => this.catalog(tenant),
        session: (tenant, id) => this.session(tenant, id),
        validateModel: (model, agent, sandbox) => this.validateModel(model, agent, sandbox),
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
    cached ??= buildApplication();
    return cached;
  };
  /** The router is built once per isolate; every handler reads its entrypoint from `c.env`. */
  function buildApplication() {
    const app = new Hono<RouteEnv<Env>>();
    // Every response, including errors and streams, carries a request ID the SDK surfaces.
    app.use("*", async (c, next) => {
      await next();
      const id = identifier("req");
      try {
        c.res.headers.set("x-request-id", id);
      } catch {
        c.res = new Response(c.res.body, c.res);
        c.res.headers.set("x-request-id", id);
      }
    });
    app.use("*", async (c, next) => {
      const tenant = await options.authenticate(c.req.raw, c.env.env);
      if (!tenant) throw new Unauthorized();
      c.set("tenant", tenant);
      await next();
    });
    // Authenticated callers only: an anonymous request never buffers an upload.
    app.use("*", async (c: Context<RouteEnv<Env>, "*", {}>, next) =>
      bodyLimit({
        maxSize:
          c.req.path === "/v1/files"
            ? INPUT_FILE_LIMIT + 64 * 1024
            : c.req.path.startsWith("/v1/skills")
              ? SKILL_UPLOAD_LIMIT + 128 * 1024
              : 16 * 1024 * 1024,
        onError: () => {
          throw new BodyTooLarge();
        },
      })(c, next),
    );
    app.onError((error) => {
      const failure = error instanceof SyntaxError ? new InvalidJson() : caughtFailure(error);
      const known = failure && toApiError(failure);
      if (!known || known.status === 500)
        console.error("Agent API request failed", { message: error.message });
      const status = known ? known.status : 500;
      const response = Response.json(
        {
          error: {
            message: known ? known.message : "Internal server error",
            type: errorType(status),
            code: known ? known.code : "internal_error",
            param: null,
          },
        },
        { status },
      );
      // The SDK retries 409 by default; these conflicts never resolve by retrying.
      if (failure && isPermanent(failure)) response.headers.set("x-should-retry", "false");
      return response;
    });
    registerCapabilityRoutes(app, options);
    registerSkillRoutes(app, options);
    registerFileRoutes(app, options);
    registerSessionRoutes(app, options);
    registerAgentRoutes(app);
    registerEnvironmentRoutes(app, options);
    registerVaultRoutes(app);
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
    return app;
  }
  return { AgentWorker, SessionDO };
}

const hasImageInput = (input: CreateSession["input"]): boolean =>
  Array.isArray(input) &&
  input.some((message) => message.content.some((part) => part.type === "input_image"));
/** Remote images are bounded per request before any state exists. */
const checkInputImages = (input: CreateSession["input"]) =>
  Effect.suspend(() =>
    Array.isArray(input) &&
    remoteImageURLs(input.flatMap((message) => message.content)).size > IMAGE_LIMIT
      ? new ImageLimitExceeded({ limit: IMAGE_LIMIT, scope: "request" })
      : Effect.void,
  );

/** OpenAI's error envelope categorizes by status; the SDK selects error classes by status too. */
function errorType(status: number): string {
  if (status === 401) return "authentication_error";
  if (status === 403) return "permission_error";
  if (status === 429) return "rate_limit_error";
  if (status >= 500) return "server_error";
  return "invalid_request_error";
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
