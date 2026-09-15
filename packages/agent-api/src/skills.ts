import { type ZippableFile, zipSync } from "fflate";
import type { Skill } from "openai/resources/skills/skills";
import type { SkillVersion } from "openai/resources/skills/versions/versions";
import { parseDocument } from "yaml";
import { z } from "zod";

import { kind } from "./persistence/kind.js";
import { ApiError, canonicalJSON, identifier, type PageQuery, parse } from "./protocol.js";
import { readSkillZip } from "./skill-zip.js";
import type { SqlStore } from "./storage.js";

export const SKILL_UPLOAD_LIMIT = 16 * 1024 * 1024;
const expandedLimit = 32 * 1024 * 1024;
const metadataSchema = z.object({
  name: z.string().min(1).max(64),
  description: z.string().min(1).max(1024),
});
export type SkillMetadata = z.infer<typeof metadataSchema>;
export interface StoredSkillVersion {
  schemaVersion: 1;
  resource: SkillVersion;
  key: string;
}
export interface ResolvedSkill extends SkillMetadata {
  skillId: string;
  version: string;
  key: string;
}
interface SkillOperationInput {
  hash: string;
  skillId?: string;
  makeDefault: boolean;
  operationId: string;
}
export interface SkillOperation {
  fingerprint: string;
  key: string;
  resource?: Skill | SkillVersion;
}
/** Every record kind the skill repository stores inside the tenant catalog. */
const Kinds = {
  skill: kind<Skill>("skill"),
  skillOperation: kind<SkillOperation>("skill_operation"),
  /** id = skill id: the last version number handed out. */
  skillCounter: kind<number>("skill_counter"),
  skillVersion: (skillId: string) => kind<StoredSkillVersion>(`skill_version:${skillId}`),
  /** Version number to version id. */
  skillVersionNumber: (skillId: string) => kind<string>(`skill_version_number:${skillId}`),
} as const;
const invalid = (message: string) => new ApiError(400, "invalid_skill", message);
function validPath(path: string): void {
  if (
    !path ||
    path.length > 1024 ||
    /[\\:]/.test(path) ||
    Array.from(path).some((char) => char.charCodeAt(0) < 32) ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw invalid("Skill file paths must be relative and cannot contain traversal");
}

/** Validate and normalize uploads before any durable write; never execute uploaded code. */
export async function readSkillUpload(
  form: FormData,
): Promise<SkillMetadata & { bundle: Uint8Array<ArrayBuffer>; makeDefault: boolean }> {
  for (const key of form.keys())
    if (!["files", "files[]", "default"].includes(key))
      throw invalid(`Unknown upload field: ${key}`);
  const files = [...form.getAll("files"), ...form.getAll("files[]")];
  if (!files.length || files.length > 1000 || files.some((file) => !(file instanceof File)))
    throw invalid("Provide skill files or one ZIP archive");
  const uploads = files as File[];
  const defaultValue = form.get("default");
  if (defaultValue !== null && defaultValue !== "true" && defaultValue !== "false")
    throw invalid("default must be a boolean");
  if (uploads.reduce((sum, file) => sum + file.size, 0) > SKILL_UPLOAD_LIMIT)
    throw new ApiError(413, "skill_too_large", "Skill upload exceeds 16 MiB");
  const entries = Object.create(null) as Record<string, Uint8Array>;
  const executable = new Set<string>();
  if (uploads.length === 1 && uploads[0]?.name.toLowerCase().endsWith(".zip")) {
    const unpacked = readSkillZip(new Uint8Array(await uploads[0].arrayBuffer()), expandedLimit);
    for (const [path, entry] of unpacked) {
      validPath(path);
      entries[path] = entry.bytes;
      if (entry.executable) executable.add(path);
    }
  } else {
    for (const file of uploads) {
      validPath(file.name);
      if (Object.hasOwn(entries, file.name)) throw invalid("Duplicate file paths");
      entries[file.name] = new Uint8Array(await file.arrayBuffer());
    }
  }
  for (const path of Object.keys(entries)) {
    const parts = path.split("/");
    for (let count = 1; count < parts.length; count++)
      if (Object.hasOwn(entries, parts.slice(0, count).join("/")))
        throw invalid("Skill file paths cannot overlap directories");
  }
  const manifests = Object.keys(entries).filter(
    (name) => name === "SKILL.md" || /^[^/]+\/SKILL\.md$/.test(name),
  );
  if (manifests.length !== 1)
    throw invalid("Expected one SKILL.md at the root or in one skill directory");
  const manifest = manifests[0];
  if (!manifest) throw invalid("Missing SKILL.md");
  const root = manifest.slice(0, -"SKILL.md".length);
  const normalized = Object.create(null) as Record<string, Uint8Array>;
  let total = 0;
  for (const [path, bytes] of Object.entries(entries)) {
    if (!path.startsWith(root)) throw invalid("All files must belong to the skill directory");
    const relative = path.slice(root.length);
    validPath(relative);
    total += bytes.length;
    if (total > expandedLimit)
      throw new ApiError(413, "skill_too_large", "Expanded skill exceeds 32 MiB");
    normalized[relative] = bytes;
  }
  const content = normalized["SKILL.md"];
  if (!content || content.length > 128_000) throw invalid("SKILL.md must be at most 128 KB");
  let metadata: SkillMetadata;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(content);
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)?.[1];
    if (!frontmatter) throw invalid("SKILL.md requires YAML name and description frontmatter");
    const document = parseDocument(frontmatter, { uniqueKeys: true });
    if (document.errors.length) throw invalid("Invalid SKILL.md frontmatter");
    metadata = metadataSchema.parse(document.toJS({ maxAliasCount: 0 }));
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw invalid("SKILL.md requires valid UTF-8 and string name/description fields");
  }
  // Repack as regular files: archive symlink/device attributes never reach the Sandbox.
  const bundle = zipSync(
    Object.fromEntries(
      Object.entries(normalized)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([path, bytes]) => [
          path,
          [
            bytes,
            {
              os: 3,
              attrs: ((0o100000 | (executable.has(root + path) ? 0o755 : 0o644)) << 16) >>> 0,
            },
          ] satisfies ZippableFile,
        ]),
    ),
    { level: 0, mtime: new Date("1980-01-01T00:00:00Z") },
  );
  return { ...metadata, bundle, makeDefault: defaultValue === "true" };
}

/** Tenant-local metadata; immutable bundles live in R2 and sessions pin their keys. */
export class SkillRepository {
  constructor(private readonly db: SqlStore) {}
  prepare(input: SkillOperationInput): SkillOperation {
    const fingerprint = canonicalJSON({
      skillId: input.skillId ?? null,
      hash: input.hash,
      makeDefault: input.makeDefault,
    });
    const previous = this.db.get(Kinds.skillOperation, input.operationId);
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        throw new ApiError(
          409,
          "idempotency_conflict",
          "Skill upload key was reused with different input",
        );
      return previous;
    }
    if (input.skillId) this.retrieve(input.skillId);
    const operation = { fingerprint, key: `skills/${identifier("bundle")}.zip` };
    this.db.put(Kinds.skillOperation, input.operationId, operation);
    return operation;
  }
  retrieve(id: string): Skill {
    return this.db.require(Kinds.skill, id);
  }
  list(query: PageQuery) {
    return this.db.list(Kinds.skill, query);
  }
  version(skillId: string, selector?: string | null): StoredSkillVersion {
    const skill = this.retrieve(skillId);
    const number =
      !selector || selector === "default"
        ? skill.default_version
        : selector === "latest"
          ? skill.latest_version
          : selector;
    const id = this.db.require(Kinds.skillVersionNumber(skillId), number);
    return this.db.require(Kinds.skillVersion(skillId), id);
  }
  versions(skillId: string, query: PageQuery) {
    this.retrieve(skillId);
    const page = this.db.list(Kinds.skillVersion(skillId), query);
    return { ...page, data: page.data.map(({ resource }) => resource) };
  }
  add(
    input: SkillMetadata &
      SkillOperationInput & {
        key: string;
      },
  ): Skill | SkillVersion {
    return this.db.transaction(() => {
      const operation = this.prepare(input);
      if (operation.resource) return operation.resource;
      if (operation.key !== input.key)
        throw new ApiError(409, "idempotency_conflict", "Skill upload reservation changed");
      const skill = input.skillId ? this.retrieve(input.skillId) : undefined;
      const skillId = skill?.id ?? identifier("skill");
      const next = (this.db.get(Kinds.skillCounter, skillId) ?? 0) + 1;
      const version: SkillVersion = {
        id: identifier("skillver"),
        object: "skill.version",
        skill_id: skillId,
        version: String(next),
        name: input.name,
        description: input.description,
        created_at: Math.floor(Date.now() / 1000),
      };
      const resource: Skill = {
        id: skillId,
        object: "skill",
        created_at: skill?.created_at ?? version.created_at,
        latest_version: version.version,
        default_version: !skill || input.makeDefault ? version.version : skill.default_version,
        name: !skill || input.makeDefault ? input.name : skill.name,
        description: !skill || input.makeDefault ? input.description : skill.description,
      };
      this.db.put(Kinds.skillCounter, skillId, next);
      this.db.put(Kinds.skillVersion(skillId), version.id, {
        schemaVersion: 1,
        resource: version,
        key: input.key,
      } satisfies StoredSkillVersion);
      this.db.put(Kinds.skillVersionNumber(skillId), version.version, version.id);
      this.db.put(Kinds.skill, skillId, resource);
      const result = skill ? version : resource;
      this.db.put(Kinds.skillOperation, input.operationId, { ...operation, resource: result });
      return result;
    });
  }
  update(skillId: string, parameters: unknown): Skill {
    const input = parse(z.strictObject({ default_version: z.string().min(1) }), parameters);
    return this.db.transaction(() => {
      const skill = this.retrieve(skillId);
      const version = this.version(skillId, input.default_version).resource;
      const resource = {
        ...skill,
        default_version: version.version,
        name: version.name,
        description: version.description,
      };
      this.db.put(Kinds.skill, skillId, resource);
      return resource;
    });
  }
  deleteVersion(skillId: string, selector: string) {
    return this.db.transaction(() => {
      const skill = this.retrieve(skillId);
      const version = this.version(skillId, selector).resource;
      if (version.version === skill.default_version)
        throw new ApiError(
          409,
          "default_skill_version",
          "Select another default version or delete the entire skill",
        );
      this.db.remove(Kinds.skillVersion(skillId), version.id);
      this.db.remove(Kinds.skillVersionNumber(skillId), version.version);
      const latest = this.versions(skillId, { order: "desc", limit: 1 }).data[0];
      if (latest) this.db.put(Kinds.skill, skillId, { ...skill, latest_version: latest.version });
      return {
        id: version.id,
        object: "skill.version.deleted" as const,
        deleted: true,
        version: version.version,
      };
    });
  }
  delete(skillId: string) {
    return this.db.transaction(() => {
      this.retrieve(skillId);
      this.db.clear(Kinds.skillVersion(skillId));
      this.db.clear(Kinds.skillVersionNumber(skillId));
      this.db.remove(Kinds.skill, skillId);
      return { id: skillId, object: "skill.deleted" as const, deleted: true };
    });
  }
}
