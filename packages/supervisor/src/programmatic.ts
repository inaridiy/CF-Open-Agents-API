import {
  type Execution,
  type JsonValue,
  programmaticInputSchema,
  workspaceTools,
} from "cf-open-agents-api";
import { Data } from "effect";
import { z } from "zod";

/** The agent has no enabled `programmatic_tool_calling` tool. */
export class CodeExecutionDisabled extends Data.TaggedError("CodeExecutionDisabled")<{}> {
  override get message(): string {
    return "Programmatic tool calling is disabled";
  }
}
/** The isolated code runner answered with an error status. */
export class CodeRunnerUnavailable extends Data.TaggedError("CodeRunnerUnavailable")<{
  readonly status: number;
}> {
  override get message(): string {
    return "Isolated code runner is unavailable";
  }
}
/** Code returned while client function calls it raised were still unanswered. */
export class CodeCallsOutstanding extends Data.TaggedError("CodeCallsOutstanding")<{}> {
  override get message(): string {
    return "Code execution left unfinished tool calls";
  }
}
/** The agent declares no function tool by that name. */
export class UnknownFunctionTool extends Data.TaggedError("UnknownFunctionTool")<{
  readonly name: string;
}> {
  override get message(): string {
    return "Unknown function tool";
  }
}

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
  if (!codeEnabled(execution)) throw new CodeExecutionDisabled();
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
  if (!response.ok) throw new CodeRunnerUnavailable({ status: response.status });
  return z
    .object({
      content: z.array(z.object({ type: z.literal("text"), text: z.string() })),
      isError: z.boolean(),
      terminal: z.boolean().optional(),
    })
    .parse(await response.json());
}
export function functionArguments(execution: Execution, name: string, args: unknown): JsonValue {
  if (!codeEnabled(execution)) throw new CodeExecutionDisabled();
  const tool = execution.agent.tools?.find(
    (candidate) => candidate.type === "function" && candidate.name === name,
  );
  if (tool?.type !== "function") throw new UnknownFunctionTool({ name });
  return z.json().parse(z.fromJSONSchema(tool.parameters).parse(args));
}
/** Names code may call before runtime-specific additions: every function tool, then the workspace tools. */
export const codeToolNames = (execution: Execution): string[] => [
  ...(execution.agent.tools ?? []).flatMap((tool) => (tool.type === "function" ? [tool.name] : [])),
  ...(execution.sandbox ? Object.keys(workspaceTools) : []),
];
