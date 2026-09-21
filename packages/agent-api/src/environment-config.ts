import { z } from "zod";

/** Paths are container paths, never host paths. Reject aliases before materialization. */
const workspacePathSchema = z
  .string()
  .max(4096)
  .refine(
    (path) =>
      path.startsWith("/workspace/") &&
      !path.includes("\0") &&
      !path
        .split("/")
        .slice(1)
        .some((part) => part === "." || part === ".." || part === ""),
    "Expected an absolute path under /workspace without traversal",
  );
export const base64Schema = z
  .string()
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
/** Padding characters at the end of a base64 string, each standing for one missing byte. */
function base64Padding(data: string): number {
  if (data.endsWith("==")) return 2;
  return data.endsWith("=") ? 1 : 0;
}
export const base64Size = (data: string) => (data.length / 4) * 3 - base64Padding(data);
export const environmentFileSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("inline"),
    path: workspacePathSchema,
    data: base64Schema.refine(
      (data) => base64Size(data) <= 5 * 1024 * 1024,
      "Inline file exceeds 5 MiB",
    ),
  }),
  z.strictObject({
    type: z.literal("file_id"),
    path: workspacePathSchema,
    file_id: z.string().min(1),
  }),
]);
/** Inline and pinned skill/plugin archives an environment installs, in total, per environment. */
export const CAPABILITY_BYTES_LIMIT = 64 * 1024 * 1024;
/** One inline archive; pinned skill bundles are bounded by the Skills API's 16 MiB. */
const INLINE_CAPABILITY_LIMIT = 16 * 1024 * 1024;
const source = z.strictObject({
  type: z.literal("base64"),
  media_type: z.literal("application/zip"),
  data: base64Schema.refine(
    (data) => base64Size(data) <= INLINE_CAPABILITY_LIMIT,
    "Inline capability archive exceeds 16 MiB",
  ),
});
const inlineCapability = z.strictObject({
  type: z.literal("inline"),
  name: z.string().min(1).max(256),
  description: z.string(),
  source,
});
function inlineCapabilityBytes(configuration: {
  skills?: readonly ({ type: "inline"; source: { data: string } } | { type: string })[] | null;
  plugins?: readonly { source: { data: string } }[] | null;
}): number {
  let total = 0;
  for (const skill of configuration.skills ?? [])
    if (skill.type === "inline" && "source" in skill) total += base64Size(skill.source.data);
  for (const plugin of configuration.plugins ?? []) total += base64Size(plugin.source.data);
  return total;
}
const networkSchema = z.strictObject({
  access: z.enum(["enabled", "disabled", "restricted"]),
  allowed_domains: z
    .array(
      z
        .string()
        .min(1)
        .max(253)
        .regex(/^(?:\*\.)?[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/),
    )
    .nullable()
    .optional(),
});
const hostedConfigurationShape = z.strictObject({
  capability_directories: z.array(z.string().min(1).max(4096)).nullable().optional(),
  env: z
    .record(z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/), z.string())
    .nullable()
    .optional(),
  files: z
    .array(environmentFileSchema)
    .max(50)
    .refine(
      (files) =>
        files.reduce(
          (sum, file) => sum + (file.type === "inline" ? base64Size(file.data) : 0),
          0,
        ) <=
        10 * 1024 * 1024,
      "Inline files exceed 10 MiB in total",
    )
    .nullable()
    .optional(),
  network: networkSchema.nullable().optional(),
  packages: z
    .strictObject({
      npm: z.array(z.string().min(1)).nullable().optional(),
      python: z.array(z.string().min(1)).nullable().optional(),
      system: z.array(z.string().min(1)).nullable().optional(),
    })
    .nullable()
    .optional(),
  plugins: z.array(inlineCapability).nullable().optional(),
  setup_commands: z
    .array(z.strictObject({ command: z.string().min(1), cwd: z.string().nullable().optional() }))
    .nullable()
    .optional(),
  skills: z
    .array(
      z.discriminatedUnion("type", [
        inlineCapability,
        z.strictObject({
          type: z.literal("skill_reference"),
          skill_id: z.string().min(1),
          version: z.string().nullable().optional(),
        }),
      ]),
    )
    .nullable()
    .optional(),
});
const capabilityBudget = (configuration: z.infer<typeof hostedConfigurationShape>) =>
  inlineCapabilityBytes(configuration) <= CAPABILITY_BYTES_LIMIT;
const CAPABILITY_BUDGET_MESSAGE = "Inline skills and plugins exceed 64 MiB in total";
export const hostedConfigurationSchema = hostedConfigurationShape.refine(
  capabilityBudget,
  CAPABILITY_BUDGET_MESSAGE,
);
export const templateSchema = hostedConfigurationShape
  .extend({ name: z.string().max(256).nullable().optional() })
  .refine(capabilityBudget, CAPABILITY_BUDGET_MESSAGE);
export type HostedConfiguration = z.infer<typeof hostedConfigurationSchema>;
export type TemplateConfiguration = z.infer<typeof templateSchema>;
export type EnvironmentFileInput = z.infer<typeof environmentFileSchema>;

/** Do not copy confidential file/archive bodies, env values or setup commands into resources. */
export function publicHostedConfiguration(input: HostedConfiguration) {
  return {
    capability_directories: input.capability_directories ?? [],
    files: (input.files ?? []).map((file) =>
      file.type === "inline"
        ? { type: file.type, path: file.path, size_bytes: atob(file.data).length }
        : file,
    ),
    network: {
      access: input.network?.access ?? "enabled",
      allowed_domains: input.network?.allowed_domains ?? [],
    },
    packages: {
      npm: input.packages?.npm ?? [],
      python: input.packages?.python ?? [],
      system: input.packages?.system ?? [],
    },
    plugins: (input.plugins ?? []).map(({ type, name, description }) => ({
      type,
      name,
      description,
    })),
    skills: (input.skills ?? []).map((skill) =>
      skill.type === "inline"
        ? { type: skill.type, name: skill.name, description: skill.description }
        : { type: skill.type, skill_id: skill.skill_id, version: skill.version ?? null },
    ),
  };
}
