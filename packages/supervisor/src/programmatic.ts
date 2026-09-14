import { type Execution, type JsonValue, programmaticInputSchema } from "cf-open-agents-api";
import { z } from "zod";

export const codeEnabled = (execution: Execution) =>
  execution.agent.tools?.some(
    (tool) => tool.type === "programmatic_tool_calling" && tool.enabled !== false,
  ) ?? false;
export async function executeCode(
  execution: Execution,
  input: unknown,
  signal: AbortSignal,
  endpoint = "http://programmatic.internal",
  invocation = "",
) {
  if (!codeEnabled(execution)) throw new Error("Programmatic tool calling is disabled");
  const parsed = programmaticInputSchema.safeParse(input);
  if (!parsed.success)
    return {
      content: [
        { type: "text" as const, text: "Provide JavaScript code and optional JSON arguments" },
      ],
      isError: true,
      terminal: false,
    };
  const response = await fetch(`${endpoint.replace(/\/$/, "")}/${execution.turnId}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-cf-code-invocation": invocation },
    body: JSON.stringify(parsed.data),
    signal,
  });
  if (!response.ok) throw new Error("Isolated code runner is unavailable");
  return z
    .object({
      content: z.array(z.object({ type: z.literal("text"), text: z.string() })),
      isError: z.boolean(),
      terminal: z.boolean().optional(),
    })
    .parse(await response.json());
}
export function functionArguments(execution: Execution, name: string, args: unknown): JsonValue {
  if (!codeEnabled(execution)) throw new Error("Programmatic tool calling is disabled");
  const tool = execution.agent.tools?.find(
    (tool) => tool.type === "function" && tool.name === name,
  );
  if (tool?.type !== "function") throw new Error("Unknown function tool");
  return z.json().parse(z.fromJSONSchema(tool.parameters).parse(args));
}
