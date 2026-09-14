import { DurableObject } from "cloudflare:workers";
import type { EnvironmentTemplate } from "openai/resources/beta/agents/environments/templates";
import type { z } from "zod";
import { publicTool } from "./agent-tools.js";
import { runPromise } from "./effect.js";
import {
  publicHostedConfiguration,
  type TemplateConfiguration,
  templateSchema,
} from "./environment-config.js";
import type { EnvironmentSpec } from "./environments.js";
import type { StoredInputFile } from "./files.js";
import type { Agent, PageQuery } from "./protocol.js";
import {
  ApiError,
  canonicalJSON,
  identifier,
  parse,
  rpcFailure,
  savedAgentSchema,
} from "./protocol.js";
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
    this.db.put("input_file", record.resource.id, record);
  }
  file(id: string): StoredInputFile {
    const record = this.db.require<StoredInputFile>("input_file", id);
    if (record.resource.expires_at !== undefined && record.resource.expires_at <= Date.now() / 1000)
      throw new ApiError(404, "not_found", "File not found");
    return record;
  }
  deleteFile(id: string): void {
    this.db.remove("input_file", id);
  }
  files(query: PageQuery, purpose?: string) {
    const page = this.db.list<StoredInputFile>("input_file", query, {
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
    this.db.put("template", resource.id, { version: 1, resource, configuration: input });
    return resource;
  }
  template(id: string): EnvironmentTemplate {
    return this.db.require<{ resource: EnvironmentTemplate }>("template", id).resource;
  }
  templateConfiguration(id: string): TemplateConfiguration {
    return this.db.require<{ configuration: TemplateConfiguration }>("template", id).configuration;
  }
  templates(query: PageQuery) {
    const page = this.db.list<{ resource: EnvironmentTemplate }>("template", query);
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
      this.db.put("template", id, { version: 1, resource, configuration });
      return resource;
    });
  }
  deleteTemplate(id: string) {
    this.template(id);
    this.db.remove("template", id);
    return { id, object: "agent.environment.template.deleted" as const, deleted: true };
  }
  registerEnvironment(spec: EnvironmentSpec): void {
    this.db.put("environment", spec.id, { version: 1, ...spec });
  }
  environment(id: string): EnvironmentSpec {
    return this.db.require<EnvironmentSpec>("environment", id);
  }
  reservation(key: string, fingerprint: string): string {
    try {
      const previous = this.db.get<Reservation>("reservation", key);
      if (previous && previous.fingerprint !== fingerprint)
        throw new ApiError(
          409,
          "idempotency_conflict",
          "Key was used with different session parameters",
        );
      return JSON.stringify({ ok: true, value: previous ?? null });
    } catch (error) {
      return JSON.stringify(rpcFailure(error));
    }
  }
  reserve(key: string, fingerprint: string, record: SessionRecord): string {
    try {
      const value = this.db.transaction(() => {
        const previous = this.db.get<Reservation>("reservation", key);
        if (previous) {
          if (previous.fingerprint !== fingerprint)
            throw new ApiError(
              409,
              "idempotency_conflict",
              "Key was used with different session parameters",
            );
          return previous;
        }
        const reservation = { id: record.session.id, record, ready: false, fingerprint };
        this.db.put("reservation", key, reservation);
        // Deletion finds the reservation by session, so the key's record can be removed.
        this.db.put("reservation_session", record.session.id, { key });
        return reservation;
      });
      return JSON.stringify({ ok: true, value });
    } catch (error) {
      return JSON.stringify(rpcFailure(error));
    }
  }
  commit(key: string): void {
    this.db.transaction(() => {
      const reservation = this.db.require<Reservation>("reservation", key);
      if (reservation.ready) return;
      this.db.put("reservation", key, { ...reservation, ready: true });
      this.db.put("session", reservation.id, {
        id: reservation.id,
        agent_id: reservation.record.session.agent.id,
      });
    });
  }
  owns(id: string): boolean {
    return this.db.get("session", id) !== undefined;
  }
  sessions(query: PageQuery & { agent_id?: string }) {
    return this.db.list<{ id: string; agent_id: string }>(
      "session",
      query,
      query.agent_id ? { field: "agent_id", value: query.agent_id } : undefined,
    );
  }
  deleteSession(id: string): void {
    this.db.transaction(() => {
      this.db.remove("session", id);
      const index = this.db.get<{ key: string }>("reservation_session", id);
      if (!index) return;
      this.db.remove("reservation", index.key);
      this.db.remove("reservation_session", id);
    });
  }
  agent(id: string): Agent {
    return this.db.require<Agent>("agent", id);
  }
  agents(query: PageQuery) {
    return this.db.list<Agent>("agent", query);
  }
  saveAgent(agent: Agent, key: string): Agent {
    return this.db.transaction(() => {
      const fingerprint = canonicalJSON({
        ...agent,
        id: undefined,
        created_at: undefined,
        updated_at: undefined,
      });
      const previous = this.db.get<{ fingerprint: string; id: string }>("agent_key", key);
      if (previous) {
        if (previous.fingerprint !== fingerprint)
          throw new ApiError(
            409,
            "idempotency_conflict",
            "Key was used with different agent parameters",
          );
        return this.agent(previous.id);
      }
      this.db.put("agent", agent.id, agent);
      this.db.put("agent_key", key, { fingerprint, id: agent.id });
      this.db.put("agent_key_index", agent.id, { key });
      return agent;
    });
  }
  deleteAgent(id: string) {
    this.db.transaction(() => {
      this.agent(id);
      this.db.remove("agent", id);
      const index = this.db.get<{ key: string }>("agent_key_index", id);
      if (!index) return;
      this.db.remove("agent_key", index.key);
      this.db.remove("agent_key_index", id);
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
      this.db.put("agent", id, resource);
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
