import { z } from "zod";

/** The same tool contract is used by Claude aliases and OpenCode replacements. */
export const workspaceTools = {
  bash: {
    description: "Run a shell command in the separate sandbox. The workspace is /workspace.",
    schema: z.object({
      command: z.string().min(1).max(64_000),
      description: z.string().optional(),
      workdir: z.string().default("/workspace"),
      timeout: z.number().int().min(1).max(120_000).default(120_000),
    }),
  },
  read: {
    description: "Read a UTF-8 file from the sandbox workspace. Line offsets are one-based.",
    schema: z.object({
      file_path: z.string(),
      offset: z.number().int().positive().default(1),
      limit: z.number().int().positive().max(2000).default(2000),
    }),
  },
  write: {
    description: "Write a UTF-8 file in the sandbox workspace, creating parent directories.",
    schema: z.object({ file_path: z.string(), content: z.string().max(1_000_000) }),
  },
  edit: {
    description:
      "Replace an exact string in a sandbox file. The original must match uniquely unless replace_all is true.",
    schema: z.object({
      file_path: z.string(),
      old_string: z.string().min(1),
      new_string: z.string(),
      replace_all: z.boolean().default(false),
    }),
  },
} as const;
export type WorkspaceToolName = keyof typeof workspaceTools;
export const workspaceRequestSchema = z.strictObject({
  tool: z.enum(["bash", "read", "write", "edit"]),
  arguments: z.record(z.string(), z.unknown()),
});
export const workspaceResultSchema = z.strictObject({
  text: z.string(),
  exitCode: z.number().nullable(),
});

export function workspacePath(path: string): string {
  const resolved = path.startsWith("/") ? path : `/workspace/${path}`;
  if (
    !resolved.startsWith("/workspace/") ||
    resolved.includes("\0") ||
    resolved.split("/").some((part) => part === "..")
  )
    throw new Error("File path must be inside /workspace");
  return resolved;
}
