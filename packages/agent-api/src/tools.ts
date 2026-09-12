import { z } from "zod";
import { ApiError } from "./protocol.js";

export interface ToolContext {
  tenantId: string;
  sessionId: string;
  operationId: string;
  signal: AbortSignal;
}
export interface ToolDefinition<Input = unknown, Output = unknown> {
  name: string;
  description: string;
  input: z.ZodType<Input>;
  output: z.ZodType<Output>;
  effects: "read" | "write";
  retry: "safe" | "reconcile" | "never";
  execute: (input: Input, context: ToolContext) => Promise<Output>;
}

export function defineTool<Input, Output>(definition: ToolDefinition<Input, Output>) {
  return {
    ...definition,
    async call(input: unknown, context: ToolContext): Promise<Output> {
      return definition.output.parse(
        await definition.execute(definition.input.parse(input), context),
      );
    },
    spec: {
      type: "function" as const,
      name: definition.name,
      description: definition.description,
      parameters: z.toJSONSchema(definition.input),
    },
  };
}

const searchResult = z.strictObject({
  title: z.string(),
  url: z.url(),
  snippet: z.string(),
});
export type SearchResult = z.infer<typeof searchResult>;
export function webSearch(
  provider: (query: string, signal: AbortSignal) => Promise<SearchResult[]>,
) {
  return defineTool({
    name: "web_search",
    description: "Search the public web. Results include URLs for citations.",
    input: z.strictObject({ query: z.string().min(1).max(2_000) }),
    output: z.array(searchResult).max(50),
    effects: "read",
    retry: "safe",
    execute: ({ query }, { signal }) => provider(query, signal),
  });
}

/** A corpus search provider is intentionally distinct from a public-web provider. */
export function knowledgeSearch(
  provider: (query: string, signal: AbortSignal) => Promise<SearchResult[]>,
) {
  return {
    ...webSearch(provider),
    name: "knowledge_search",
    spec: {
      ...webSearch(provider).spec,
      name: "knowledge_search",
      description: "Search the configured knowledge corpus.",
    },
  };
}

export const skillManifestSchema = z.strictObject({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  description: z.string().min(1).max(1_024),
  files: z.record(z.string(), z.string().max(512_000)),
});

export interface SkillReference {
  key: string;
  sha256: string;
}

/** Immutable UTF-8 skill bundles; paths are validated before writing anything. */
export async function publishSkill(bucket: R2Bucket, input: unknown): Promise<SkillReference> {
  const { manifest, data } = serializeSkill(input);
  const sha256 = await digest(data);
  const key = `skills/${manifest.name}/${sha256}.json`;
  await bucket.put(key, data, { onlyIf: { etagDoesNotMatch: "*" } });
  return { key, sha256 };
}

function serializeSkill(input: unknown) {
  const manifest = skillManifestSchema.parse(input);
  for (const path of Object.keys(manifest.files)) {
    if (
      path.startsWith("/") ||
      path.includes("\\") ||
      path.includes("\0") ||
      path.split("/").some((part) => !part || part === "." || part === "..")
    ) {
      throw new ApiError(400, "invalid_skill_path", `Invalid skill path: ${path}`);
    }
  }
  if (!("SKILL.md" in manifest.files))
    throw new ApiError(400, "missing_skill", "A bundle must contain SKILL.md");
  const data = JSON.stringify({
    ...manifest,
    files: Object.fromEntries(
      Object.entries(manifest.files).sort(([a], [b]) => a.localeCompare(b)),
    ),
  });
  if (new TextEncoder().encode(data).length > 4_000_000)
    throw new ApiError(413, "skill_too_large", "Skill bundles are limited to 4 MB");
  return { manifest, data };
}

async function digest(data: string): Promise<string> {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data))),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}

export async function loadSkill(bucket: R2Bucket, reference: SkillReference) {
  const object = await bucket.get(reference.key);
  if (!object) throw new ApiError(404, "skill_missing", "Skill bundle not found");
  if (object.size > 4_000_000) throw new ApiError(413, "skill_too_large", "Invalid skill size");
  const { manifest, data } = serializeSkill(await object.json());
  if (
    (await digest(data)) !== reference.sha256 ||
    reference.key !== `skills/${manifest.name}/${reference.sha256}.json`
  )
    throw new ApiError(409, "skill_integrity", "Skill content does not match its reference");
  return manifest;
}

/** Progressive disclosure through the same function interface on every harness. */
export function skillReader(bucket: R2Bucket, allowed: Record<string, SkillReference>) {
  return defineTool({
    name: "read_skill",
    description: `Read an installed skill file. Start with SKILL.md. Available skills: ${Object.keys(allowed).join(", ")}`,
    input: z.strictObject({ name: z.string(), path: z.string().default("SKILL.md") }),
    output: z.string().max(512_000),
    effects: "read",
    retry: "safe",
    execute: async ({ name, path }) => {
      const reference = Object.hasOwn(allowed, name) ? allowed[name] : undefined;
      if (!reference) throw new ApiError(404, "skill_missing", "Skill is not installed");
      const manifest = await loadSkill(bucket, reference);
      if (!Object.hasOwn(manifest.files, path))
        throw new ApiError(404, "skill_file_missing", "Skill file not found");
      return manifest.files[path] as string;
    },
  });
}

/** Provision trusted assets before starting untrusted code; scripts stay in the sandbox. */
export async function installSkill(
  bucket: R2Bucket,
  reference: SkillReference,
  sandbox: {
    mkdir(path: string, options: { recursive: boolean }): Promise<unknown>;
    writeFile(path: string, content: string): Promise<unknown>;
  },
): Promise<string> {
  const manifest = await loadSkill(bucket, reference);
  const root = `/workspace/.agents/skills/${manifest.name}`;
  for (const [path, content] of Object.entries(manifest.files)) {
    const destination = `${root}/${path}`;
    await sandbox.mkdir(destination.slice(0, destination.lastIndexOf("/")), { recursive: true });
    await sandbox.writeFile(destination, content);
  }
  return root;
}
