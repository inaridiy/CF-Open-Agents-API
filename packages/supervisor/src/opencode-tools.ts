import { workspaceResultSchema, workspaceTools } from "cf-open-agents-api";
import { z } from "zod";

/** OpenCode gives same-name plugin tools precedence over its built-in tools. */
export default async function workspacePlugin() {
  const endpoint = process.env.CF_WORKSPACE_ENDPOINT;
  if (!endpoint) throw new Error("No workspace endpoint is configured");
  const definitions = {
    bash: {
      command: z.string(),
      description: z.string().optional(),
      timeout: z.number().optional(),
      workdir: z.string().optional(),
    },
    read: { filePath: z.string(), offset: z.number().optional(), limit: z.number().optional() },
    write: { filePath: z.string(), content: z.string() },
    edit: {
      filePath: z.string(),
      oldString: z.string(),
      newString: z.string(),
      replaceAll: z.boolean().optional(),
    },
  };
  return {
    tool: Object.fromEntries(
      Object.entries(definitions).map(([name, args]) => [
        name,
        {
          description: workspaceTools[name as keyof typeof workspaceTools].description,
          args,
          async execute(input: Record<string, unknown>) {
            const normalized =
              name === "bash"
                ? input
                : {
                    file_path: input.filePath,
                    content: input.content,
                    offset: input.offset,
                    limit: input.limit,
                    old_string: input.oldString,
                    new_string: input.newString,
                    replace_all: input.replaceAll,
                  };
            const response = await fetch(endpoint, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ tool: name, arguments: normalized }),
            });
            if (!response.ok) throw new Error("Sandbox tool failed");
            const result = workspaceResultSchema.parse(await response.json());
            return result.text;
          },
        },
      ]),
    ),
  };
}
