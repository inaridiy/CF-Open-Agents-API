import {
  type RuntimeEvent,
  type WorkspaceToolName,
  workspaceResultSchema,
  workspaceTools,
} from "cf-open-agents-api";
import { z } from "zod";

const streamEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("delta"), text: z.string() }),
  workspaceResultSchema.extend({ type: z.literal("result") }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);
export async function executeWorkspace(
  endpoint: string,
  name: WorkspaceToolName,
  args: unknown,
  signal: AbortSignal,
  emit: (event: RuntimeEvent) => void,
) {
  const input = workspaceTools[name].schema.parse(args);
  const id = crypto.randomUUID();
  const command = name === "bash" ? workspaceTools.bash.schema.parse(input) : undefined;
  const started = Date.now();
  let output = "";
  if (command) emit({ type: "command_start", id, command: command.command, cwd: command.workdir });
  try {
    const response = await fetch(`${endpoint.replace(/^ws/, "http").replace(/\/$/, "")}/tools`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/x-ndjson" },
      body: JSON.stringify({ tool: name, arguments: input }),
      signal,
    });
    if (!response.ok) throw new Error(`Sandbox operation failed (${response.status})`);
    let result: z.infer<typeof workspaceResultSchema> | undefined;
    if (!response.headers.get("content-type")?.includes("application/x-ndjson"))
      result = workspaceResultSchema.parse(await response.json());
    else {
      if (!response.body) throw new Error("Missing command stream");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        for (;;) {
          const chunk = await reader.read();
          buffer += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
          if (buffer.length > 8_000_000) throw new Error("Command stream exceeds its limit");
          for (;;) {
            const boundary = buffer.indexOf("\n");
            if (boundary < 0) break;
            const line = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 1);
            if (!line) continue;
            const event = streamEvent.parse(JSON.parse(line));
            if (event.type === "error") throw new Error(event.message);
            // Callers parse the result strictly; the stream tag must not leak into it.
            if (event.type === "result") result = { text: event.text, exitCode: event.exitCode };
            else {
              output += event.text;
              if (command) emit({ type: "command_delta", id, text: event.text });
            }
          }
          if (chunk.done) break;
        }
      } finally {
        await reader.cancel();
      }
    }
    if (!result) throw new Error("Command stream ended without a result");
    if (command)
      emit({
        type: "command",
        id,
        command: command.command,
        cwd: command.workdir,
        output: result.text,
        exitCode: result.exitCode,
        durationMs: Date.now() - started,
      });
    return result;
  } catch (error) {
    if (command)
      emit({
        type: "command",
        id,
        command: command.command,
        cwd: command.workdir,
        output,
        exitCode: null,
        durationMs: Date.now() - started,
      });
    throw error;
  }
}
