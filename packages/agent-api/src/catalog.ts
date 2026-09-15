import { DurableObject } from "cloudflare:workers";
import { Schema } from "effect";
import type { EnvironmentTemplate } from "openai/resources/beta/agents/environments/templates";
import type { z } from "zod";

import { publicTool } from "./agent-tools.js";
import { attempt, runPromise, runSync } from "./effect.js";
import {
  publicHostedConfiguration,
  type TemplateConfiguration,
  templateSchema,
} from "./environment-config.js";
import type { EnvironmentSpec } from "./environments.js";
import { encodeRpc, IdempotencyConflict, rpcEnvelope } from "./errors.js";
import type { StoredInputFile } from "./files.js";
import { kind } from "./persistence/kind.js";
import type { Agent, PageQuery } from "./protocol.js";
import { ApiError, canonicalJSON, identifier, parse, savedAgentSchema } from "./protocol.js";
import type { SessionRecord } from "./session.js";
import { SkillRepository } from "./skills.js";
import { SqlStore } from "./storage.js";
import { VaultRepository } from "./vaults.js";

export interface Reservation {
  id: string;
  record: SessionRecord;
  ready: boolean;
  fingerprint: string;
}
const reservationSchema = Schema.declare<Reservation>(
  (input): input is Reservation =>
    typeof input === "object" && input !== null && "id" in input && "record" in input,
);
/** String carriers: the RPC type of the session record inside a reservation is too deep. */
export const ReservationResult = Schema.parseJson(rpcEnvelope(Schema.NullOr(reservationSchema)));
export const ReserveResult = Schema.parseJson(rpcEnvelope(reservationSchema));
interface TemplateRecord {
  version: 1;
  resource: EnvironmentTemplate;
  configuration: TemplateConfiguration;
}
/** Every record kind the tenant catalog stores; skills and vaults declare their own. */
export const CatalogKinds = {
  inputFile: kind<StoredInputFile>("input_file"),
  template: kind<TemplateRecord>("template"),
  environment: kind<EnvironmentSpec & { version: 1 }>("environment"),
  /** Idempotency key to the session it reserved. */
  reservation: kind<Reservation>("reservation"),
  /** Session id back to its reservation key, so deletion can drop both. */
  reservationSession: kind<{ key: string }>("reservation_session"),
  session: kind<{ id: string; agent_id: string }>("session"),
  agent: kind<Agent>("agent"),
  agentKey: kind<{ fingerprint: string; id: string }>("agent_key"),
  agentKeyIndex: kind<{ key: string }>("agent_key_index"),
} as const;

/** One catalog per authenticated tenant, never one global object. */
export class CatalogObject extends DurableObject {
  readonly db = new SqlStore(this.ctx.storage);
  private readonly skillStore = new SkillRepository(this.db);
  skill(...args: Parameters<SkillRepository["retrieve"]>) {
    return this.skillStore.retrieve(...args);
  }
  skills(...args: Parameters<SkillRepository["list"]>) {
    return this.skillStore.list(...args);
  }
  skillVersion(...args: Parameters<SkillRepository["version"]>) {
    return this.skillStore.version(...args);
  }
  skillVersions(...args: Parameters<SkillRepository["versions"]>) {
    return this.skillStore.versions(...args);
  }
  addSkill(...args: Parameters<SkillRepository["add"]>) {
    return this.skillStore.add(...args);
  }
  prepareSkill(...args: Parameters<SkillRepository["prepare"]>) {
    return this.skillStore.prepare(...args);
  }
  updateSkill(...args: Parameters<SkillRepository["update"]>) {
    return this.skillStore.update(...args);
  }
  deleteSkill(...args: Parameters<SkillRepository["delete"]>) {
    return this.skillStore.delete(...args);
  }
  deleteSkillVersion(...args: Parameters<SkillRepository["deleteVersion"]>) {
    return this.skillStore.deleteVersion(...args);
  }
  saveFile(record: StoredInputFile): void {
    this.db.put(CatalogKinds.inputFile, record.resource.id, record);
  }
  file(id: string): StoredInputFile {
    const record = this.db.require(CatalogKinds.inputFile, id);
    if (record.resource.expires_at !== undefined && record.resource.expires_at <= Date.now() / 1000)
      throw new ApiError(404, "not_found", "File not found");
    return record;
  }
  deleteFile(id: string): void {
    this.db.remove(CatalogKinds.inputFile, id);
  }
  files(query: PageQuery, purpose?: string) {
    const page = this.db.list(CatalogKinds.inputFile, query, {
      ...(purpose ? { field: "resource.purpose" as const, value: purpose } : {}),
      expiresAfter: Date.now() / 1000,
    });
    return { ...page, data: page.data.map(({ resource }) => resource) };
  }
  private readonly vaultStore = new VaultRepository(this.db);
  mcpToken(vaultIds: string[], url: string, credentialId?: string | null) {
    return runPromise(this.vaultStore.token(vaultIds, url, credentialId));
  }
  createVault(...args: Parameters<VaultRepository["create"]>) {
    return this.vaultStore.create(...args);
  }
  vault(...args: Parameters<VaultRepository["retrieve"]>) {
    return this.vaultStore.retrieve(...args);
  }
  vaults(...args: Parameters<VaultRepository["list"]>) {
    return this.vaultStore.list(...args);
  }
  deleteVault(...args: Parameters<VaultRepository["delete"]>) {
    return this.vaultStore.delete(...args);
  }
  createCredential(...args: Parameters<VaultRepository["createCredential"]>) {
    return this.vaultStore.createCredential(...args);
  }
  credential(...args: Parameters<VaultRepository["credential"]>) {
    return this.vaultStore.credential(...args);
  }
  credentials(...args: Parameters<VaultRepository["credentials"]>) {
    return this.vaultStore.credentials(...args);
  }
  rotateCredential(...args: Parameters<VaultRepository["rotate"]>) {
    return this.vaultStore.rotate(...args);
  }
  deleteCredential(...args: Parameters<VaultRepository["deleteCredential"]>) {
    return this.vaultStore.deleteCredential(...args);
  }
  createTemplate(parameters: TemplateConfiguration): EnvironmentTemplate {
    const input = parse(templateSchema, parameters);
    const now = Math.floor(Date.now() / 1000);
    const resource: EnvironmentTemplate = {
      ...publicHostedConfiguration(input),
      id: identifier("envtmpl"),
      object: "agent.environment.template",
      name: input.name ?? null,
      created_at: now,
      updated_at: now,
    };
    this.db.put(CatalogKinds.template, resource.id, { version: 1, resource, configuration: input });
    return resource;
  }
  template(id: string): EnvironmentTemplate {
    return this.db.require(CatalogKinds.template, id).resource;
  }
  templateConfiguration(id: string): TemplateConfiguration {
    return this.db.require(CatalogKinds.template, id).configuration;
  }
  templates(query: PageQuery) {
    const page = this.db.list(CatalogKinds.template, query);
    return { ...page, data: page.data.map(({ resource }) => resource) };
  }
  updateTemplate(id: string, parameters: TemplateConfiguration): EnvironmentTemplate {
    return this.db.transaction(() => {
      const input = parse(templateSchema, parameters);
      const configuration = { ...this.templateConfiguration(id), ...input };
      const resource: EnvironmentTemplate = {
        ...this.template(id),
        ...publicHostedConfiguration(configuration),
        name: configuration.name ?? null,
        updated_at: Math.floor(Date.now() / 1000),
      };
      this.db.put(CatalogKinds.template, id, { version: 1, resource, configuration });
      return resource;
    });
  }
  deleteTemplate(id: string) {
    this.template(id);
    this.db.remove(CatalogKinds.template, id);
    return { id, object: "agent.environment.template.deleted" as const, deleted: true };
  }
  registerEnvironment(spec: EnvironmentSpec): void {
    this.db.put(CatalogKinds.environment, spec.id, { version: 1, ...spec });
  }
  environment(id: string): EnvironmentSpec {
    return this.db.require(CatalogKinds.environment, id);
  }
  reservation(key: string, fingerprint: string): string {
    return runSync(
      encodeRpc(
        ReservationResult,
        attempt("catalog.reservation", () => {
          const previous = this.db.get(CatalogKinds.reservation, key);
          if (previous && previous.fingerprint !== fingerprint)
            throw new IdempotencyConflict({ subject: "session parameters" });
          return previous ?? null;
        }),
      ),
      "catalog.reservation",
    );
  }
  reserve(key: string, fingerprint: string, record: SessionRecord): string {
    return runSync(
      encodeRpc(
        ReserveResult,
        attempt("catalog.reserve", () =>
          this.db.transaction(() => {
            const previous = this.db.get(CatalogKinds.reservation, key);
            if (previous) {
              if (previous.fingerprint !== fingerprint)
                throw new IdempotencyConflict({ subject: "session parameters" });
              return previous;
            }
            const reservation = { id: record.session.id, record, ready: false, fingerprint };
            this.db.put(CatalogKinds.reservation, key, reservation);
            // Deletion finds the reservation by session, so the key's record can be removed.
            this.db.put(CatalogKinds.reservationSession, record.session.id, { key });
            return reservation;
          }),
        ),
      ),
      "catalog.reserve",
    );
  }
  commit(key: string): void {
    this.db.transaction(() => {
      const reservation = this.db.require(CatalogKinds.reservation, key);
      if (reservation.ready) return;
      this.db.put(CatalogKinds.reservation, key, { ...reservation, ready: true });
      this.db.put(CatalogKinds.session, reservation.id, {
        id: reservation.id,
        agent_id: reservation.record.session.agent.id,
      });
    });
  }
  owns(id: string): boolean {
    return this.db.get(CatalogKinds.session, id) !== undefined;
  }
  sessions(query: PageQuery & { agent_id?: string }) {
    return this.db.list(
      CatalogKinds.session,
      query,
      query.agent_id ? { field: "agent_id", value: query.agent_id } : undefined,
    );
  }
  deleteSession(id: string): void {
    this.db.transaction(() => {
      this.db.remove(CatalogKinds.session, id);
      const index = this.db.get(CatalogKinds.reservationSession, id);
      if (!index) return;
      this.db.remove(CatalogKinds.reservation, index.key);
      this.db.remove(CatalogKinds.reservationSession, id);
    });
  }
  agent(id: string): Agent {
    return this.db.require(CatalogKinds.agent, id);
  }
  agents(query: PageQuery) {
    return this.db.list(CatalogKinds.agent, query);
  }
  saveAgent(agent: Agent, key: string): Agent {
    return this.db.transaction(() => {
      const fingerprint = canonicalJSON({
        ...agent,
        id: undefined,
        created_at: undefined,
        updated_at: undefined,
      });
      const previous = this.db.get(CatalogKinds.agentKey, key);
      if (previous) {
        if (previous.fingerprint !== fingerprint)
          throw new IdempotencyConflict({ subject: "agent parameters" });
        return this.agent(previous.id);
      }
      this.db.put(CatalogKinds.agent, agent.id, agent);
      this.db.put(CatalogKinds.agentKey, key, { fingerprint, id: agent.id });
      this.db.put(CatalogKinds.agentKeyIndex, agent.id, { key });
      return agent;
    });
  }
  deleteAgent(id: string) {
    this.db.transaction(() => {
      this.agent(id);
      this.db.remove(CatalogKinds.agent, id);
      const index = this.db.get(CatalogKinds.agentKeyIndex, id);
      if (!index) return;
      this.db.remove(CatalogKinds.agentKey, index.key);
      this.db.remove(CatalogKinds.agentKeyIndex, id);
    });
    return { id, object: "agent.deleted" as const, deleted: true };
  }
  updateAgent(id: string, input: Partial<z.infer<typeof savedAgentSchema>>): Agent {
    return this.db.transaction(() => {
      const previous = this.agent(id);
      const configuration = parse(savedAgentSchema, {
        model: previous.model,
        name: previous.name,
        metadata: previous.metadata,
        instructions: previous.instructions,
        tools: previous.tools,
        multi_agent: {
          enabled: previous.multi_agent.enabled,
          ...(previous.multi_agent.max_concurrent_subagents != null
            ? { max_concurrent_subagents: previous.multi_agent.max_concurrent_subagents }
            : {}),
        },
        reasoning: previous.reasoning,
        text: previous.text,
        service_tier: previous.service_tier,
        ...input,
      });
      const resource = { ...agentResource(configuration), id, created_at: previous.created_at };
      this.db.put(CatalogKinds.agent, id, resource);
      return resource;
    });
  }
}

export function agentResource(input: z.infer<typeof savedAgentSchema>): Agent {
  const now = Math.floor(Date.now() / 1_000);
  return {
    id: identifier("agent"),
    object: "agent",
    created_at: now,
    updated_at: now,
    name: input.name ?? null,
    model: input.model,
    instructions: input.instructions ?? null,
    metadata: input.metadata ?? {},
    tools: (input.tools ?? []).map(publicTool),
    multi_agent: {
      enabled: input.multi_agent?.enabled ?? false,
      max_concurrent_subagents: input.multi_agent?.enabled
        ? (input.multi_agent.max_concurrent_subagents ?? 6)
        : null,
    },
    reasoning: {
      effort: input.reasoning?.effort ?? null,
      summary: input.reasoning?.summary ?? null,
    },
    service_tier: input.service_tier ?? "auto",
    text: {
      format: input.text?.format ?? { type: "text" },
      verbosity: input.text?.verbosity ?? "medium",
    },
  };
}
