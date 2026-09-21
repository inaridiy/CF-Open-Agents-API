import { Effect } from "effect";
import type { HostedSkill } from "openai/resources/beta/agents/agents";

import { sessionTools } from "./agent-tools.js";
import type { CatalogObject } from "./catalog.js";
import { attempt, io } from "./effect.js";
import type { HostedConfiguration, TemplateConfiguration } from "./environment-config.js";
import type { EnvironmentSpec } from "./environments.js";
import { mergeEnvironment } from "./environments.js";
import type { ResolvedInputFile } from "./files.js";
import type { SessionRecord } from "./persistence/session-record.js";
import type { Agent, AgentConfig, AgentSession, CreateSession } from "./protocol.js";
import { canonicalJSON, identifier } from "./protocol.js";
import type { AgentRegistration, RuntimeDriver } from "./runtime.js";
import type { ForkSource } from "./session.js";
import type { ResolvedSkill } from "./skills.js";

export type Catalog = DurableObjectStub<CatalogObject>;
/** The agent configuration a saved agent contributes beneath the request's inline fields. */
export function savedAgentConfig(saved: Agent | undefined) {
  if (!saved) return {};
  return {
    model: saved.model,
    instructions: saved.instructions,
    tools: saved.tools,
    multi_agent: {
      enabled: saved.multi_agent.enabled,
      ...(saved.multi_agent.max_concurrent_subagents != null
        ? { max_concurrent_subagents: saved.multi_agent.max_concurrent_subagents }
        : {}),
    },
    reasoning: saved.reasoning,
    text: saved.text,
    service_tier: saved.service_tier,
  };
}
/** The raw hosted configuration: a template's fields beneath the request's inline ones. */
export function hostedConfiguration(catalog: Catalog, environment: CreateSession["environment"]) {
  return Effect.gen(function* () {
    if (environment.type !== "openai_hosted") return {};
    const { type: _type, environment_template_id: templateId, ...inline } = environment;
    const base: TemplateConfiguration = templateId
      ? yield* io("api.template", () => catalog.templateConfiguration(templateId))
      : {};
    const { name: _name, ...template } = base;
    return yield* attempt("api.environment.merge", () => mergeEnvironment(template, inline));
  });
}
/** Skills, plugins and capability directories need a driver that mounts them. */
export const configuresCapabilities = (configured: HostedConfiguration) =>
  !!(
    configured.skills?.length ||
    configured.plugins?.length ||
    configured.capability_directories?.length
  );
/** Referenced input files must exist before the environment is reserved. */
export function resolveInputFiles(catalog: Catalog, configured: HostedConfiguration) {
  return Effect.gen(function* () {
    const inputFiles: Record<string, ResolvedInputFile> = {};
    for (const file of configured.files ?? []) {
      if (file.type !== "file_id") continue;
      const stored = yield* io("api.file", () => catalog.file(file.file_id));
      inputFiles[file.file_id] = { key: stored.key, size: stored.resource.bytes };
    }
    return inputFiles;
  });
}
/**
 * Resolve skill references to stored versions, pinning each reference's version in the
 * configuration that is written to R2, and list every skill as the session presents it.
 */
export function resolveSkills(catalog: Catalog, configured: HostedConfiguration) {
  return Effect.gen(function* () {
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
    return { resolvedSkills, installedSkills };
  });
}
/** The public file list of a hosted environment; sizes come from the stored input files. */
export function publicEnvironmentFiles(
  configured: HostedConfiguration,
  inputFiles: Record<string, ResolvedInputFile>,
) {
  return (configured.files ?? []).map((file) =>
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
  );
}
/**
 * The checkpoint a fork continues from: native history transfers only between identical
 * harness revisions, and a runtime that fixes tools at thread start cannot resume with a
 * different tool surface.
 */
export function forkedCheckpoint(
  source: ForkSource,
  agent: AgentConfig,
  registration: AgentRegistration,
  driver: RuntimeDriver,
  agents: Record<string, AgentRegistration>,
): SessionRecord["checkpoint"] {
  const sameHarness = registration.harness === source.driver && driver.revision === source.revision;
  const surface = (config: AgentConfig, delegates: readonly string[] | undefined) =>
    canonicalJSON({
      tools: config.tools ?? [],
      subagents: !!config.multi_agent?.enabled,
      delegates: config.multi_agent?.enabled ? (delegates ?? []) : [],
    });
  const retooled =
    surface(source.agent, agents[source.session.agent.model]?.delegates) !==
    surface(agent, registration.delegates);
  if (!sameHarness || !source.checkpoint || (driver.capabilities.toolsFixedAtStart && retooled))
    return null;
  return {
    version: 1 as const,
    driver: source.checkpoint.driver,
    revision: source.checkpoint.revision,
    native: source.checkpoint.native,
    ...(source.checkpoint.workspace ? { workspace: source.checkpoint.workspace } : {}),
    ...(source.checkpoint.environmentFileVersion !== undefined
      ? { environmentFileVersion: source.checkpoint.environmentFileVersion }
      : {}),
  };
}
/** A forked hosted environment inherits the source's spec under the new identity. */
export function forkedEnvironment(
  source: ForkSource,
  sessionId: string,
  environmentId: string,
): EnvironmentSpec | undefined {
  if (!source.environmentSpec) return;
  return {
    ...source.environmentSpec,
    id: environmentId,
    sessionId,
    inherited: {
      sessionId: source.session.id,
      environmentId: source.environmentSpec.id,
      ...(source.checkpoint?.workspace ? { workspace: source.checkpoint.workspace } : {}),
    },
  };
}

/** What creation and forking each decide before the shared record is written. */
interface NewSession {
  tenant: string;
  sessionId: string;
  /** The public agent resource of the session and the id it is presented under. */
  agentId: string;
  resource: Agent;
  agent: AgentConfig;
  driver: RuntimeDriver;
  registration: AgentRegistration;
  vaultIds: string[];
  metadata: Record<string, string>;
  environment: AgentSession["environment"];
  checkpoint: SessionRecord["checkpoint"];
  environmentSpec?: EnvironmentSpec;
  /** A fork: its source and the transcript the first turn prepends when no checkpoint transfers. */
  fork?: { sessionId: string; lastTurnId: string | null; transcript: string };
}
/** The idle session record a reservation stores; creation and forking differ only in the input. */
export function newSessionRecord(input: NewSession): SessionRecord {
  const now = Math.floor(Date.now() / 1_000);
  const { resource } = input;
  const session: AgentSession = {
    id: input.sessionId,
    object: "agent.session",
    agent: {
      id: input.agentId,
      instructions: resource.instructions,
      model: resource.model,
      name: resource.name,
      multi_agent: resource.multi_agent,
      reasoning: resource.reasoning,
      service_tier: resource.service_tier,
      text: resource.text,
      tools: sessionTools(input.agent.tools ?? []),
    },
    created_at: now,
    last_active_at: now,
    status: "idle",
    error: null,
    required_actions: [],
    metadata: input.metadata,
    usage: null,
    vault_ids: input.vaultIds,
    environment: input.environment,
  };
  return {
    schemaVersion: 2,
    tenant: input.tenant,
    session,
    agent: input.agent,
    driver: input.driver.name,
    revision: input.driver.revision,
    model: input.registration.model,
    ...(input.registration.tiers ? { tiers: input.registration.tiers } : {}),
    generation: 0,
    checkpoint: input.checkpoint,
    execution: null,
    cursor: 0,
    phase: "idle",
    deleted: false,
    ...(input.environmentSpec ? { environmentSpec: input.environmentSpec } : {}),
    ...(input.fork && !input.checkpoint && input.fork.transcript
      ? { inheritedTranscript: input.fork.transcript }
      : {}),
    ...(input.fork
      ? { forkedFrom: { sessionId: input.fork.sessionId, turnId: input.fork.lastTurnId } }
      : {}),
  };
}
