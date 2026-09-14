import { WorkerEntrypoint } from "cloudflare:workers";
import { Effect } from "effect";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { HostedSkill } from "openai/resources/beta/agents/agents";
import { z } from "zod";
import { sessionTools } from "./agent-tools.js";
import type { CatalogObject, Reservation } from "./catalog.js";
import { agentResource } from "./catalog.js";
import { attempt, io, runPromise } from "./effect.js";
import {
  environmentFileSchema,
  hostedConfigurationSchema,
  publicHostedConfiguration,
  type TemplateConfiguration,
  templateSchema,
} from "./environment-config.js";
import type { EnvironmentSpec } from "./environments.js";
import { environmentFilePageSchema, mergeEnvironment } from "./environments.js";
import { INPUT_FILE_LIMIT, type ResolvedInputFile, uploadInputFile } from "./files.js";
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
  ApiError,
  agentConfigSchema,
  assertImageLimit,
  COMPATIBILITY,
  canonicalJSON,
  createSessionSchema,
  eventsSchema,
  forkSessionSchema,
  identifier,
  inputMessages,
  metadataSchema,
  pageSchema,
  parse,
  type RpcResult,
  remoteApiError,
  remoteImageURLs,
  reservedDelegationName,
  savedAgentSchema,
  sessionPageSchema,
  unwrap,
} from "./protocol.js";
import type { AgentRegistration, RuntimeDriver, ServiceOptions } from "./runtime.js";
import type { ForkSource, SessionRecord } from "./session.js";
import { SessionObject } from "./session.js";
import { type ResolvedSkill, readSkillUpload, SKILL_UPLOAD_LIMIT } from "./skills.js";
import {
  credentialSchema,
  rotateCredentialSchema,
  vaultPageSchema,
  vaultSchema,
} from "./vaults.js";

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
/** The per-request view route handlers use; it keeps private helpers off the RPC surface. */
interface WorkerAccess<Env> extends AgentRPC {
  env: Env;
  catalog(tenant: string): DurableObjectStub<CatalogObject>;
  session(tenant: string, id: string): Promise<DurableObjectStub<SessionObject>>;
  validateModel(
    model: string,
    agent: {
      tools?: readonly { type: string; defer_loading?: boolean; enabled?: boolean }[] | null;
      multi_agent?: { enabled: boolean } | null;
    },
    sandbox: boolean,
  ): { registration: AgentRegistration; driver: RuntimeDriver };
}
type RouteEnv<Env> = { Bindings: WorkerAccess<Env>; Variables: { tenant: string } };

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
    private session(tenant: string, id: string) {
      return runPromise(
        Effect.gen(this, function* () {
          if (!(yield* io("api.session", () => this.catalog(tenant).owns(id))))
            return yield* Effect.fail(new ApiError(404, "not_found", "Session not found"));
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
      const registration = options.agents[model];
      const driver = registration && options.harnesses(this.env)[registration.harness];
      if (!registration || !driver)
        throw new ApiError(422, "unsupported_model", "Model is not registered in this deployment");
      const tools = agent.tools ?? [];
      const unsupported = (message: string) => new ApiError(422, "unsupported_capability", message);
      if (
        (tools.length > 0 && !driver.capabilities.functions) ||
        (sandbox && !driver.capabilities.sandbox)
      )
        throw unsupported("The selected harness does not support this configuration");
      if (
        agent.multi_agent?.enabled &&
        !driver.capabilities.subagents &&
        !registration.delegates?.length
      )
        throw unsupported("The selected harness does not support subagents");
      if (reservedDelegationName(agent))
        throw new ApiError(
          400,
          "invalid_request",
          "Subagent delegation reserves cf_delegate, cf_wait and cf_close",
        );
      if (agent.multi_agent?.enabled)
        for (const alias of registration.delegates ?? []) {
          const target = options.agents[alias];
          if (!target || !options.harnesses(this.env)[target.harness])
            throw new ApiError(
              503,
              "delegate_unavailable",
              `Delegate preset ${alias} is not registered in this deployment`,
            );
        }
      if (tools.some((tool) => tool.type === "mcp") && !driver.capabilities.mcp)
        throw unsupported("The selected harness does not support MCP servers");
      // Hosted search needs both a runtime that drives it and a model connection that provides it.
      if (
        tools.some((tool) => tool.type === "web_search") &&
        !(driver.capabilities.webSearch && registration.webSearch === true)
      )
        throw unsupported("The selected harness or model alias does not support web search");
      if (
        tools.some(
          (tool) => tool.type === "tool_search" || (tool.type === "function" && tool.defer_loading),
        ) &&
        !driver.capabilities.toolSearch
      )
        throw unsupported("The selected harness does not support deferred tool loading");
      if (
        tools.some((tool) => tool.type === "programmatic_tool_calling" && tool.enabled !== false) &&
        !driver.capabilities.programmaticToolCalling
      )
        throw unsupported("Programmatic tool calling requires a configured isolated code runner");
      return { registration, driver };
    }
    /** MCP placement rules that depend on the environment rather than the driver. */
    private validateMcp(agent: AgentConfig, hosted: boolean): void {
      for (const tool of agent.tools ?? []) {
        if (tool.type !== "mcp") continue;
        const environmentOrigin =
          tool.transport.type === "stdio" || tool.connection_origin === "environment";
        if (environmentOrigin && !hosted)
          throw new ApiError(
            400,
            "invalid_request",
            "Environment-origin MCP requires an execution environment",
          );
        if (tool.transport.type === "stdio" && tool.connection_origin === "service")
          throw new ApiError(400, "invalid_request", "Stdio MCP runs in the execution environment");
        if (
          environmentOrigin &&
          (tool.credential_id || Object.keys(tool.request_metadata ?? {}).length)
        )
          throw new ApiError(
            422,
            "unsupported_capability",
            "Environment-origin MCP cannot use vault credentials or request metadata",
          );
      }
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
        if (reservation.ready) return yield* io("api.createSession", () => stub.retrieve());
        yield* io("api.createSession", () => stub.initialize(reservation.record));
        const environmentSpec = reservation.record.environmentSpec;
        if (environmentSpec) {
          yield* io("api.environment.register", () => catalog.registerEnvironment(environmentSpec));
          const environments = options.environments?.(this.env);
          if (!environments)
            return yield* new ApiError(
              503,
              "environment_unavailable",
              "Environment driver is unavailable",
            );
          yield* io("api.environment.pending", () => stub.environmentStatus("pending"));
          const prepared = yield* environments.prepare(environmentSpec).pipe(Effect.either);
          if (prepared._tag === "Left") {
            yield* io("api.environment.failed", () => stub.environmentStatus("failed"));
            yield* io("api.createSession", () => catalog.commit(idempotencyKey));
            return yield* io("api.createSession", () => stub.retrieve());
          }
          yield* io("api.environment.connected", () => stub.environmentStatus("connected"));
        }
        if (initialInput)
          unwrap(
            yield* io<RpcResult<null>>("api.createSession", () =>
              stub.submit(
                [{ type: "agent.session.input.message", input: inputMessages(initialInput) }],
                `${idempotencyKey}:initial`,
              ),
            ),
          );
        yield* io("api.createSession", () => catalog.commit(idempotencyKey));
        return yield* io("api.createSession", () => stub.retrieve());
      });
    }
    createSession(
      tenant: string,
      parameters: CreateSession,
      idempotencyKey = identifier("key"),
    ): Promise<AgentSession> {
      return runPromise(
        Effect.gen(this, function* () {
          const input = yield* attempt("api.validate", () =>
            parse(createSessionSchema, parameters),
          );
          yield* attempt("api.images", () => assertInputImages(input.input));
          const catalog = yield* attempt("api.catalog", () => this.catalog(tenant));
          const fingerprint = yield* this.fingerprint(input);
          const previous = unwrap(
            JSON.parse(
              yield* io("api.reservation", () => catalog.reservation(idempotencyKey, fingerprint)),
            ) as RpcResult<Reservation | null>,
          );
          const reservation =
            previous ??
            (yield* Effect.gen(this, function* () {
              const agentId = input.agent_id;
              const saved: Agent | undefined = agentId
                ? yield* io("api.createSession", () => catalog.agent(agentId))
                : undefined;
              const agent = yield* attempt("api.agent.validate", () =>
                parse(agentConfigSchema, {
                  ...(saved
                    ? {
                        model: saved.model,
                        instructions: saved.instructions,
                        tools: saved.tools,
                        multi_agent: {
                          enabled: saved.multi_agent.enabled,
                          ...(saved.multi_agent.max_concurrent_subagents != null
                            ? {
                                max_concurrent_subagents:
                                  saved.multi_agent.max_concurrent_subagents,
                              }
                            : {}),
                        },
                        reasoning: saved.reasoning,
                        text: saved.text,
                        service_tier: saved.service_tier,
                      }
                    : {}),
                  ...input.agent,
                }),
              );
              const { registration, driver } = yield* attempt("api.model.validate", () =>
                this.validateModel(agent.model, agent, input.environment.type !== "none"),
              );
              if (
                Array.isArray(input.input) &&
                input.input.some((message) =>
                  message.content.some((part) => part.type === "input_image"),
                ) &&
                !driver.capabilities.images
              )
                return yield* new ApiError(
                  422,
                  "unsupported_capability",
                  "The selected harness does not support image input",
                );
              for (const id of input.vault_ids ?? [])
                yield* io("api.vault", () => catalog.vault(id));
              yield* attempt("api.mcp.validate", () =>
                this.validateMcp(agent, input.environment.type !== "none"),
              );
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
              const configured = yield* attempt("api.environment.validate", () =>
                parse(hostedConfigurationSchema, configuration),
              );
              if (
                !driver.capabilities.environmentCapabilities &&
                (configured.skills?.length ||
                  configured.plugins?.length ||
                  configured.capability_directories?.length)
              )
                return yield* new ApiError(
                  422,
                  "unsupported_capability",
                  "The selected harness does not support environment skills or plugins",
                );
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
                return yield* new ApiError(
                  422,
                  "unsupported_capability",
                  "Configured environments require an environment driver and object storage",
                );
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
              return unwrap(
                JSON.parse(
                  yield* io("api.createSession", () =>
                    catalog.reserve(idempotencyKey, fingerprint, record),
                  ),
                ) as RpcResult<Reservation>,
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
      return runPromise(
        Effect.gen(this, function* () {
          const input = yield* attempt("api.validate", () => parse(forkSessionSchema, parameters));
          yield* attempt("api.images", () => assertInputImages(input.input));
          const catalog = yield* attempt("api.catalog", () => this.catalog(tenant));
          const fingerprint = yield* this.fingerprint({ fork: id, ...input });
          const previous = unwrap(
            JSON.parse(
              yield* io("api.reservation", () => catalog.reservation(idempotencyKey, fingerprint)),
            ) as RpcResult<Reservation | null>,
          );
          const reservation =
            previous ??
            (yield* Effect.gen(this, function* () {
              const sourceStub = yield* io("api.fork.session", () => this.session(tenant, id));
              const source = unwrap(
                JSON.parse(
                  yield* io("api.fork.source", () => sourceStub.forkSource()),
                ) as RpcResult<ForkSource>,
              );
              const hosted = source.session.environment.type !== "none";
              const agent = yield* attempt("api.agent.validate", () =>
                parse(agentConfigSchema, { ...source.agent, ...input.agent }),
              );
              const { registration, driver } = yield* attempt("api.model.validate", () =>
                this.validateModel(agent.model, agent, hosted),
              );
              yield* attempt("api.mcp.validate", () => this.validateMcp(agent, hosted));
              if (
                Array.isArray(input.input) &&
                input.input.some((message) =>
                  message.content.some((part) => part.type === "input_image"),
                ) &&
                !driver.capabilities.images
              )
                return yield* new ApiError(
                  422,
                  "unsupported_capability",
                  "The selected harness does not support image input",
                );
              const vaultIds = input.vault_ids ?? source.session.vault_ids;
              for (const vaultId of vaultIds) yield* io("api.vault", () => catalog.vault(vaultId));
              if (hosted && source.environmentSpec && !(options.environments && options.objects))
                return yield* new ApiError(
                  422,
                  "unsupported_capability",
                  "Forking a configured environment requires an environment driver",
                );
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
              return unwrap(
                JSON.parse(
                  yield* io("api.forkSession", () =>
                    catalog.reserve(idempotencyKey, fingerprint, record),
                  ),
                ) as RpcResult<Reservation>,
              );
            }));
          return yield* this.establish(tenant, idempotencyKey, reservation, input.input);
        }),
      );
    }
    retrieveSession(tenant: string, id: string): Promise<AgentSession> {
      return runPromise(
        Effect.gen(this, function* () {
          const stub = yield* io("api.retrieveSession", () => this.session(tenant, id));
          return yield* io("api.retrieveSession", () => stub.retrieve());
        }),
      );
    }
    submitEvents(tenant: string, id: string, events: InputEvent[], key = identifier("key")) {
      return runPromise(
        Effect.gen(this, function* () {
          const parsed = yield* attempt("api.events.validate", () =>
            parse(eventsSchema, { events }),
          );
          const stub = yield* io("api.submitEvents", () => this.session(tenant, id));
          unwrap(
            yield* io<RpcResult<null>>("api.submitEvents", () => stub.submit(parsed.events, key)),
          );
        }),
      );
    }
    listSessions(
      tenant: string,
      query: Partial<PageQuery> & { agent_id?: string } = {},
    ): Promise<ListPage<AgentSession>> {
      return runPromise(
        Effect.gen(this, function* () {
          const page = yield* io("api.listSessions", () =>
            this.catalog(tenant).sessions(parse(sessionPageSchema, query)),
          );
          // A session deleted but not yet removed from discovery must not fail the page.
          const sessions = yield* Effect.forEach(
            page.data,
            ({ id }) =>
              io("api.retrieveSession", () => this.retrieveSession(tenant, id)).pipe(
                Effect.catchIf(
                  (error) => error._tag === "ApiError" && error.status === 404,
                  () => Effect.succeed(undefined),
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
      return runPromise(
        Effect.gen(this, function* () {
          const page = yield* attempt("api.page.validate", () => parse(pageSchema, query));
          const stub = yield* io("api.listItems", () => this.session(tenant, id));
          return yield* io("api.listItems", () => stub.items(page));
        }),
      );
    }
    listTurns(tenant: string, id: string, query: Partial<PageQuery> = {}): Promise<ListPage<Turn>> {
      return runPromise(
        Effect.gen(this, function* () {
          const page = yield* attempt("api.page.validate", () => parse(pageSchema, query));
          const stub = yield* io("api.listTurns", () => this.session(tenant, id));
          return yield* io("api.listTurns", () => stub.turns(page));
        }),
      );
    }
    retrieveTurn(tenant: string, id: string, turnId: string): Promise<Turn> {
      return runPromise(
        Effect.gen(this, function* () {
          const stub = yield* io("api.retrieveTurn", () => this.session(tenant, id));
          return yield* io("api.retrieveTurn", () => stub.turn(turnId));
        }),
      );
    }
    deleteSession(tenant: string, id: string) {
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
      if (!tenant) throw new ApiError(401, "unauthorized", "Authentication required");
      c.set("tenant", tenant);
      await next();
    });
    // Authenticated callers only: an anonymous request never buffers an upload.
    app.use("*", async (c, next) =>
      bodyLimit({
        maxSize:
          c.req.path === "/v1/files"
            ? INPUT_FILE_LIMIT + 64 * 1024
            : c.req.path.startsWith("/v1/skills")
              ? SKILL_UPLOAD_LIMIT + 128 * 1024
              : 16 * 1024 * 1024,
        onError: () => {
          throw new ApiError(413, "body_too_large", "Request exceeds its upload limit");
        },
      })(c, next),
    );
    app.onError((error) => {
      const known =
        error instanceof SyntaxError
          ? new ApiError(400, "invalid_json", "Request body must be valid JSON")
          : remoteApiError(error);
      if (!known) console.error("Agent API request failed", { message: error.message });
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
      if (known && PERMANENT_CONFLICTS.has(known.code))
        response.headers.set("x-should-retry", "false");
      return response;
    });
    app.get("/cf/v1/capabilities", (c) =>
      Response.json({
        ...COMPATIBILITY,
        agents: options.agents,
        harnesses: Object.fromEntries(
          Object.values(options.harnesses(c.env.env)).map((driver) => [
            driver.name,
            { revision: driver.revision, ...driver.capabilities },
          ]),
        ),
        extensions: ["event_replay"],
        hosted_environment_provider: "cloudflare",
      }),
    );
    const objects = (worker: WorkerAccess<Env>) => {
      const bucket = options.objects?.(worker.env);
      if (!bucket)
        throw new ApiError(503, "storage_unavailable", "Object storage is not configured");
      return bucket;
    };
    const uploadSkill = async (
      worker: WorkerAccess<Env>,
      request: Request,
      tenant: string,
      skillId?: string,
    ) => {
      const catalog = worker.catalog(tenant);
      const bucket = objects(worker);
      let form: FormData;
      try {
        form = await request.formData();
      } catch {
        throw new ApiError(400, "invalid_skill", "Provide multipart skill files or a ZIP archive");
      }
      const { bundle, makeDefault, ...metadata } = await readSkillUpload(form);
      const hash = Array.from(
        new Uint8Array(await crypto.subtle.digest("SHA-256", bundle)),
        (byte) => byte.toString(16).padStart(2, "0"),
      ).join("");
      const operation = {
        hash,
        skillId,
        makeDefault,
        operationId: request.headers.get("Idempotency-Key") ?? identifier("key"),
      };
      const { key, resource } = await catalog.prepareSkill(operation);
      if (resource) return resource;
      await bucket.put(key, bundle, { httpMetadata: { contentType: "application/zip" } });
      return catalog.addSkill({
        ...metadata,
        key,
        ...operation,
      });
    };
    const skillContent = async (
      worker: WorkerAccess<Env>,
      tenant: string,
      id: string,
      selector?: string,
    ) => {
      const version = await worker.catalog(tenant).skillVersion(id, selector);
      const object = await objects(worker).get(version.key);
      if (!object) throw new ApiError(404, "not_found", "Skill content not found");
      return new Response(object.body, {
        headers: {
          "content-type": "application/zip",
          "content-length": String(object.size),
          "content-disposition": "attachment",
        },
      });
    };
    app.post("/v1/skills", async (c) =>
      Response.json(await uploadSkill(c.env, c.req.raw, c.get("tenant"))),
    );
    app.get("/v1/skills", async (c) =>
      Response.json(await c.env.catalog(c.get("tenant")).skills(parse(pageSchema, c.req.query()))),
    );
    app.get("/v1/skills/:id", async (c) =>
      Response.json(await c.env.catalog(c.get("tenant")).skill(c.req.param("id"))),
    );
    app.post("/v1/skills/:id", async (c) =>
      Response.json(
        await c.env.catalog(c.get("tenant")).updateSkill(c.req.param("id"), await jsonBody(c)),
      ),
    );
    app.delete("/v1/skills/:id", async (c) =>
      Response.json(await c.env.catalog(c.get("tenant")).deleteSkill(c.req.param("id"))),
    );
    app.get("/v1/skills/:id/content", (c) =>
      skillContent(c.env, c.get("tenant"), c.req.param("id")),
    );
    app.post("/v1/skills/:id/versions", async (c) =>
      Response.json(await uploadSkill(c.env, c.req.raw, c.get("tenant"), c.req.param("id"))),
    );
    app.get("/v1/skills/:id/versions", async (c) =>
      Response.json(
        await c.env
          .catalog(c.get("tenant"))
          .skillVersions(c.req.param("id"), parse(pageSchema, c.req.query())),
      ),
    );
    app.get("/v1/skills/:id/versions/:version", async (c) =>
      Response.json(
        (
          await c.env
            .catalog(c.get("tenant"))
            .skillVersion(c.req.param("id"), c.req.param("version"))
        ).resource,
      ),
    );
    app.delete("/v1/skills/:id/versions/:version", async (c) =>
      Response.json(
        await c.env
          .catalog(c.get("tenant"))
          .deleteSkillVersion(c.req.param("id"), c.req.param("version")),
      ),
    );
    app.get("/v1/skills/:id/versions/:version/content", (c) =>
      skillContent(c.env, c.get("tenant"), c.req.param("id"), c.req.param("version")),
    );
    app.post("/v1/files", async (c) => {
      const record = await runPromise(uploadInputFile(objects(c.env), await c.req.formData()));
      await c.env.catalog(c.get("tenant")).saveFile(record);
      return Response.json(record.resource);
    });
    app.get("/v1/files", async (c) => {
      const { purpose, ...page } = parse(
        pageSchema.extend({ purpose: z.string().max(64).optional() }),
        c.req.query(),
      );
      return Response.json(await c.env.catalog(c.get("tenant")).files(page, purpose));
    });
    app.get("/v1/files/:id", async (c) =>
      Response.json((await c.env.catalog(c.get("tenant")).file(c.req.param("id"))).resource),
    );
    app.get("/v1/files/:id/content", async (c) => {
      const record = await c.env.catalog(c.get("tenant")).file(c.req.param("id"));
      const object = await objects(c.env).get(record.key);
      if (!object) throw new ApiError(404, "not_found", "File content not found");
      return new Response(object.body, {
        headers: {
          "content-type": "application/octet-stream",
          "content-length": String(object.size),
          "content-disposition": "attachment",
        },
      });
    });
    app.delete("/v1/files/:id", async (c) => {
      const catalog = c.env.catalog(c.get("tenant"));
      const record = await catalog.file(c.req.param("id"));
      await objects(c.env).delete(record.key);
      await catalog.deleteFile(record.resource.id);
      return Response.json({ id: record.resource.id, object: "file", deleted: true });
    });
    app.post("/v1/agents/sessions", async (c) => {
      const input = parse(createSessionSchema, await jsonBody(c));
      const session = await c.env.createSession(
        c.get("tenant"),
        input,
        c.req.header("Idempotency-Key"),
      );
      // A creation stream covers the initial turn, then ends; live streams use /events.
      return input.stream
        ? await (await c.env.session(c.get("tenant"), session.id)).stream(0, { initial: true })
        : Response.json(session);
    });
    app.get("/v1/agents/sessions", async (c) =>
      Response.json(
        await c.env.listSessions(c.get("tenant"), parse(sessionPageSchema, c.req.query())),
      ),
    );
    app.get("/v1/agents/sessions/:id", async (c) =>
      Response.json(await c.env.retrieveSession(c.get("tenant"), c.req.param("id"))),
    );
    app.post("/v1/agents/sessions/:id", async (c) => {
      const input = parse(z.strictObject({ metadata: metadataSchema }), await jsonBody(c));
      const stub = await c.env.session(c.get("tenant"), c.req.param("id"));
      return Response.json(
        input.metadata === undefined
          ? await stub.retrieve()
          : await stub.update(input.metadata ?? {}),
      );
    });
    app.delete("/v1/agents/sessions/:id", async (c) =>
      Response.json(await c.env.deleteSession(c.get("tenant"), c.req.param("id"))),
    );
    app.post("/v1/agents/sessions/:id/events", async (c) => {
      const input = parse(eventsSchema, await jsonBody(c));
      await c.env.submitEvents(
        c.get("tenant"),
        c.req.param("id"),
        input.events,
        c.req.header("Idempotency-Key"),
      );
      return c.body(null, 204);
    });
    app.get(
      "/v1/agents/sessions/:id/events",
      async (c) => await (await c.env.session(c.get("tenant"), c.req.param("id"))).stream(),
    );
    app.post("/cf/v1/sessions/:id/fork", async (c) => {
      // A fork needs no body; an empty or absent one means "same configuration".
      const body = await c.req.text();
      return Response.json(
        await c.env.forkSession(
          c.get("tenant"),
          c.req.param("id"),
          parse(forkSessionSchema, body.trim() ? JSON.parse(body) : {}),
          c.req.header("Idempotency-Key"),
        ),
      );
    });
    app.get("/cf/v1/sessions/:id/events", async (c) => {
      const after = parse(z.coerce.number().int().min(0), c.req.query("after") ?? "0");
      return Response.json(
        await (await c.env.session(c.get("tenant"), c.req.param("id"))).replay(after),
      );
    });
    app.get("/v1/agents/sessions/:id/items", async (c) =>
      Response.json(
        await c.env.listItems(c.get("tenant"), c.req.param("id"), parse(pageSchema, c.req.query())),
      ),
    );
    app.get("/v1/agents/sessions/:id/turns", async (c) =>
      Response.json(
        await c.env.listTurns(c.get("tenant"), c.req.param("id"), parse(pageSchema, c.req.query())),
      ),
    );
    app.get("/v1/agents/sessions/:id/turns/:turn", async (c) =>
      Response.json(
        await c.env.retrieveTurn(c.get("tenant"), c.req.param("id"), c.req.param("turn")),
      ),
    );
    app.get("/v1/agents/sessions/:id/subagents", async (c) =>
      Response.json(
        await (await c.env.session(c.get("tenant"), c.req.param("id"))).subagents(
          parse(pageSchema, c.req.query()),
        ),
      ),
    );
    app.get("/v1/agents/sessions/:id/subagents/:subagent", async (c) =>
      Response.json(
        await (await c.env.session(c.get("tenant"), c.req.param("id"))).subagent(
          c.req.param("subagent"),
        ),
      ),
    );
    app.get("/v1/agents/sessions/:id/subagents/:subagent/items", async (c) =>
      Response.json(
        await (await c.env.session(c.get("tenant"), c.req.param("id"))).subagentItems(
          c.req.param("subagent"),
          parse(pageSchema, c.req.query()),
        ),
      ),
    );
    app.get("/v1/agents/sessions/:id/subagents/:subagent/turns", async (c) =>
      Response.json(
        await (await c.env.session(c.get("tenant"), c.req.param("id"))).subagentTurns(
          c.req.param("subagent"),
          parse(pageSchema, c.req.query()),
        ),
      ),
    );
    app.get("/v1/agents/sessions/:id/subagents/:subagent/turns/:turn", async (c) =>
      Response.json(
        await (await c.env.session(c.get("tenant"), c.req.param("id"))).subagentTurn(
          c.req.param("subagent"),
          c.req.param("turn"),
        ),
      ),
    );
    app.get("/v1/agents/sessions/:id/subagents/:subagent/turns/:turn/items", async (c) =>
      Response.json(
        await (await c.env.session(c.get("tenant"), c.req.param("id"))).subagentItems(
          c.req.param("subagent"),
          parse(pageSchema, c.req.query()),
          c.req.param("turn"),
        ),
      ),
    );
    app.get("/v1/agents/sessions/:id/artifacts", async (c) => {
      const query = parse(
        pageSchema.extend({ environment_id: z.string().nullable().optional() }),
        c.req.query(),
      );
      const { environment_id, ...page } = query;
      return Response.json(
        await (await c.env.session(c.get("tenant"), c.req.param("id"))).artifacts(
          page,
          environment_id ?? undefined,
        ),
      );
    });
    app.get("/v1/agents/sessions/:id/artifacts/:artifact", async (c) => {
      const { key: _key, ...resource } = await (
        await c.env.session(c.get("tenant"), c.req.param("id"))
      ).artifact(c.req.param("artifact"));
      return Response.json(resource);
    });
    app.get("/v1/agents/sessions/:id/artifacts/:artifact/content", async (c) => {
      const artifact = await (await c.env.session(c.get("tenant"), c.req.param("id"))).artifact(
        c.req.param("artifact"),
      );
      const object = await options.objects?.(c.env.env).get(artifact.key);
      if (!object) throw new ApiError(404, "not_found", "Artifact content not found");
      return new Response(object.body, {
        headers: {
          "content-type": "application/octet-stream",
          "content-length": String(object.size),
          "content-disposition": "attachment",
          etag: object.httpEtag,
        },
      });
    });
    app.delete("/v1/agents/sessions/:id/artifacts/:artifact", async (c) => {
      const stub = await c.env.session(c.get("tenant"), c.req.param("id"));
      const artifact = await stub.artifact(c.req.param("artifact"));
      await options.objects?.(c.env.env).delete(artifact.key);
      await stub.deleteArtifact(artifact.id);
      return Response.json({
        id: artifact.id,
        object: "agent.session.artifact.deleted",
        deleted: true,
      });
    });
    app.post("/v1/agents", async (c) => {
      const input = parse(savedAgentSchema, await jsonBody(c));
      c.env.validateModel(input.model, input, false);
      return Response.json(
        await c.env
          .catalog(c.get("tenant"))
          .saveAgent(agentResource(input), c.req.header("Idempotency-Key") ?? identifier("key")),
      );
    });
    app.get("/v1/agents", async (c) =>
      Response.json(await c.env.catalog(c.get("tenant")).agents(parse(pageSchema, c.req.query()))),
    );
    app.get("/v1/agents/:id", async (c) =>
      Response.json(await c.env.catalog(c.get("tenant")).agent(c.req.param("id"))),
    );
    app.post("/v1/agents/:id", async (c) => {
      const input = parse(savedAgentSchema.partial(), await jsonBody(c));
      const catalog = c.env.catalog(c.get("tenant"));
      const previous = await catalog.agent(c.req.param("id"));
      c.env.validateModel(
        input.model ?? previous.model,
        {
          tools: input.tools === undefined ? previous.tools : input.tools,
          multi_agent:
            input.multi_agent === undefined
              ? { enabled: previous.multi_agent.enabled }
              : input.multi_agent,
        },
        false,
      );
      return Response.json(await catalog.updateAgent(c.req.param("id"), input));
    });
    app.delete("/v1/agents/:id", async (c) =>
      Response.json(await c.env.catalog(c.get("tenant")).deleteAgent(c.req.param("id"))),
    );
    app.post("/v1/agents/environments/templates", async (c) =>
      Response.json(
        await c.env
          .catalog(c.get("tenant"))
          .createTemplate(parse(templateSchema, await jsonBody(c))),
      ),
    );
    app.get("/v1/agents/environments/templates", async (c) =>
      Response.json(
        await c.env.catalog(c.get("tenant")).templates(parse(pageSchema, c.req.query())),
      ),
    );
    app.get("/v1/agents/environments/templates/:id", async (c) =>
      Response.json(await c.env.catalog(c.get("tenant")).template(c.req.param("id"))),
    );
    app.post("/v1/agents/environments/templates/:id", async (c) =>
      Response.json(
        await c.env
          .catalog(c.get("tenant"))
          .updateTemplate(c.req.param("id"), parse(templateSchema, await jsonBody(c))),
      ),
    );
    app.delete("/v1/agents/environments/templates/:id", async (c) =>
      Response.json(await c.env.catalog(c.get("tenant")).deleteTemplate(c.req.param("id"))),
    );
    app.get("/v1/agents/environments/:id", async (c) => {
      const spec = await c.env.catalog(c.get("tenant")).environment(c.req.param("id"));
      const stub = await c.env.session(c.get("tenant"), spec.sessionId);
      const session = await stub.retrieve();
      if (session.environment.type !== "openai_hosted")
        throw new ApiError(404, "not_found", "Environment not found");
      const { files, plugins, skills } = session.environment;
      const status = await runPromise(
        options.environments?.(c.env.env).status(spec) ?? Effect.succeed("failed"),
      );
      // A sandbox that went away, or came back after a restore, is reflected as a session event.
      if (status === "disconnected" || status === "connected") await stub.environmentStatus(status);
      return Response.json({
        id: spec.id,
        object: "agent.environment",
        type: "openai_hosted",
        files,
        plugins,
        skills,
        status,
      });
    });
    app.post("/v1/agents/environments/:id/files", async (c) => {
      const spec = await c.env.catalog(c.get("tenant")).environment(c.req.param("id"));
      await c.env.session(c.get("tenant"), spec.sessionId);
      const driver = options.environments?.(c.env.env);
      if (!driver)
        throw new ApiError(503, "environment_unavailable", "Environment driver is unavailable");
      const input = parse(environmentFileSchema, await jsonBody(c));
      if (input.type === "file_id") {
        const file = await c.env.catalog(c.get("tenant")).file(input.file_id);
        spec.inputFiles = {
          ...spec.inputFiles,
          [input.file_id]: { key: file.key, size: file.resource.bytes },
        };
      }
      return Response.json(await runPromise(driver.upload(spec, input)));
    });
    app.get("/v1/agents/environments/:id/files", async (c) => {
      const spec = await c.env.catalog(c.get("tenant")).environment(c.req.param("id"));
      await c.env.session(c.get("tenant"), spec.sessionId);
      const driver = options.environments?.(c.env.env);
      if (!driver)
        throw new ApiError(503, "environment_unavailable", "Environment driver is unavailable");
      return Response.json(
        await runPromise(driver.files(spec, parse(environmentFilePageSchema, c.req.query()))),
      );
    });
    app.post("/v1/vaults", async (c) =>
      Response.json(
        await c.env.catalog(c.get("tenant")).createVault(parse(vaultSchema, await jsonBody(c))),
      ),
    );
    const vaultQuery = (url: string) => {
      const query = new URL(url).searchParams;
      const statuses = query.getAll("status[]");
      const input = Object.fromEntries(query);
      delete input["status[]"];
      return parse(vaultPageSchema, {
        ...input,
        ...(statuses.length ? { status: statuses } : {}),
      });
    };
    app.get("/v1/vaults", async (c) =>
      Response.json(await c.env.catalog(c.get("tenant")).vaults(vaultQuery(c.req.url))),
    );
    app.get("/v1/vaults/:id", async (c) =>
      Response.json(await c.env.catalog(c.get("tenant")).vault(c.req.param("id"))),
    );
    app.delete("/v1/vaults/:id", async (c) =>
      Response.json(await c.env.catalog(c.get("tenant")).deleteVault(c.req.param("id"))),
    );
    app.post("/v1/vaults/:id/credentials", async (c) =>
      Response.json(
        await c.env
          .catalog(c.get("tenant"))
          .createCredential(c.req.param("id"), parse(credentialSchema, await jsonBody(c))),
      ),
    );
    app.get("/v1/vaults/:id/credentials", async (c) =>
      Response.json(
        await c.env.catalog(c.get("tenant")).credentials(c.req.param("id"), vaultQuery(c.req.url)),
      ),
    );
    app.get("/v1/vaults/:id/credentials/:credential", async (c) =>
      Response.json(
        await c.env
          .catalog(c.get("tenant"))
          .credential(c.req.param("id"), c.req.param("credential")),
      ),
    );
    app.post("/v1/vaults/:id/credentials/:credential", async (c) =>
      Response.json(
        await c.env
          .catalog(c.get("tenant"))
          .rotateCredential(
            c.req.param("id"),
            c.req.param("credential"),
            parse(rotateCredentialSchema, await jsonBody(c)),
          ),
      ),
    );
    app.delete("/v1/vaults/:id/credentials/:credential", async (c) =>
      Response.json(
        await c.env
          .catalog(c.get("tenant"))
          .deleteCredential(c.req.param("id"), c.req.param("credential")),
      ),
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
    return app;
  }
  return { AgentWorker, SessionDO };
}

/** Conflicts a retry cannot resolve; the SDK honors `x-should-retry: false`. */
const PERMANENT_CONFLICTS = new Set([
  "idempotency_conflict",
  "active_turn",
  "session_failed",
  "turn_checkpointing",
  "active_turn_not_steerable",
  "outcome_unknown",
  "network_policy_conflict",
  "invalid_session_state",
  "not_deleted",
  "environment_conflict",
]);
function assertInputImages(input: CreateSession["input"]): void {
  if (Array.isArray(input))
    assertImageLimit(remoteImageURLs(input.flatMap((message) => message.content)));
}
/**
 * The official SDK sends no body when every parameter of an update or create call is
 * omitted; an absent or empty body means "no changes", not malformed JSON.
 */
async function jsonBody(c: { req: { raw: Request; text(): Promise<string> } }): Promise<unknown> {
  if (!c.req.raw.body) return {};
  const text = await c.req.text();
  return text.trim() ? JSON.parse(text) : {};
}

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
