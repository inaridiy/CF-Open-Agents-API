import { Effect, JSONSchema, Schema } from "effect";

import { decode, decodeEffect, io, runPromise, type ServiceError } from "./effect.js";
import { ApiError } from "./protocol.js";

export interface ToolContext {
  tenantId: string;
  sessionId: string;
  operationId: string;
  signal: AbortSignal;
}
export interface ToolDefinition<
  Input = unknown,
  Output = unknown,
  E = ServiceError,
  EncodedInput = Input,
  EncodedOutput = Output,
> {
  name: string;
  description: string;
  input: Schema.Schema<Input, EncodedInput>;
  output: Schema.Schema<Output, EncodedOutput>;
  effects: "read" | "write";
  retry: "safe" | "reconcile" | "never";
  execute: (input: Input, context: ToolContext) => Effect.Effect<Output, E>;
}

export function defineTool<Input, Output, E, EncodedInput, EncodedOutput>(
  definition: ToolDefinition<Input, Output, E, EncodedInput, EncodedOutput>,
) {
  const effect = (input: unknown, context: ToolContext) =>
    Effect.gen(function* () {
      const value = yield* decodeEffect(definition.input, input);
      const output = yield* definition.execute(value, context);
      return yield* decodeEffect(Schema.typeSchema(definition.output), output);
    });
  return {
    ...definition,
    effect,
    call: (input: unknown, context: ToolContext): Promise<Output> =>
      runPromise(effect(input, context)),
    spec: {
      type: "function" as const,
      name: definition.name,
      description: definition.description,
      parameters: JSONSchema.make(definition.input),
    },
  };
}

const searchResult = Schema.Struct({
  title: Schema.String,
  url: Schema.String.pipe(Schema.filter((value) => URL.canParse(value))),
  snippet: Schema.String,
});
export type SearchResult = typeof searchResult.Type;
export function webSearch(
  provider: (query: string, signal: AbortSignal) => Promise<SearchResult[]>,
) {
  return defineTool({
    name: "web_search",
    description: "Search the public web. Results include URLs for citations.",
    input: Schema.Struct({
      query: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(2000)),
    }),
    output: Schema.mutable(Schema.Array(searchResult)).pipe(Schema.maxItems(50)),
    effects: "read",
    retry: "safe",
    execute: ({ query }, { signal }) =>
      io("tool.search", (interrupted) => provider(query, AbortSignal.any([signal, interrupted]))),
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

export const skillManifestSchema = Schema.Struct({
  name: Schema.String.pipe(Schema.pattern(/^[a-z0-9][a-z0-9-]{0,63}$/)),
  description: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(1024)),
  files: Schema.Record({ key: Schema.String, value: Schema.String.pipe(Schema.maxLength(512000)) }),
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
  const manifest = decode(skillManifestSchema, input);
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
    input: Schema.Struct({
      name: Schema.String,
      path: Schema.optionalWith(Schema.String, { default: () => "SKILL.md" }),
    }),
    output: Schema.String.pipe(Schema.maxLength(512000)),
    effects: "read",
    retry: "safe",
    execute: ({ name, path }) =>
      Effect.gen(function* () {
        const reference = Object.hasOwn(allowed, name) ? allowed[name] : undefined;
        if (!reference) return yield* new ApiError(404, "skill_missing", "Skill is not installed");
        const manifest = yield* io("skill.load", () => loadSkill(bucket, reference));
        if (!Object.hasOwn(manifest.files, path))
          return yield* new ApiError(404, "skill_file_missing", "Skill file not found");
        return manifest.files[path] as string;
      }),
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
