import {
  type RuntimeEvent,
  type WorkspaceToolName,
  workspaceResultSchema,
  workspaceTools,
} from "cf-open-agents-api";
import { Data } from "effect";
import { z } from "zod";

/** The execution has no sandbox, or the job is stopping: no workspace call can be made. */
export class NoSandboxAssignment extends Data.TaggedError("NoSandboxAssignment")<{}> {
  override get message(): string {
    return "No active sandbox assignment";
  }
}
/** The sandbox refused or broke off a workspace tool call; the model reads `reason`. */
export class WorkspaceToolFailed extends Data.TaggedError("WorkspaceToolFailed")<{
  readonly tool: string;
  readonly reason: string;
}> {
  override get message(): string {
    return this.reason;
  }
}

const streamEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("delta"), text: z.string() }),
  workspaceResultSchema.extend({ type: z.literal("result") }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);
type WorkspaceResult = z.infer<typeof workspaceResultSchema>;
/** Reads the ndjson command stream: deltas are forwarded, the result returned, an error event fails the call. */
async function readStream(
  body: ReadableStream<unknown>,
  failed: (reason: string) => WorkspaceToolFailed,
  onDelta: (text: string) => void,
): Promise<WorkspaceResult | undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result: WorkspaceResult | undefined;
  try {
    for (;;) {
      const chunk = await reader.read();
      buffer += chunk.done
        ? decoder.decode()
        : decoder.decode(chunk.value as Uint8Array, { stream: true });
      if (buffer.length > 8_000_000) throw failed("Command stream exceeds its limit");
      for (;;) {
        const boundary = buffer.indexOf("\n");
        if (boundary < 0) break;
        const line = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 1);
        if (!line) continue;
        const event = streamEvent.parse(JSON.parse(line));
        if (event.type === "error") throw failed(event.message);
        // Callers parse the result strictly; the stream tag must not leak into it.
        if (event.type === "result") result = { text: event.text, exitCode: event.exitCode };
        else onDelta(event.text);
      }
      if (chunk.done) break;
    }
  } finally {
    await reader.cancel();
  }
  return result;
}
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
  const failed = (reason: string) => new WorkspaceToolFailed({ tool: name, reason });
  try {
    const response = await fetch(`${endpoint.replace(/^ws/, "http").replace(/\/$/, "")}/tools`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/x-ndjson" },
      body: JSON.stringify({ tool: name, arguments: input }),
      signal,
    });
    if (!response.ok) throw failed(`Sandbox operation failed (${response.status})`);
    let result: WorkspaceResult | undefined;
    if (!response.headers.get("content-type")?.includes("application/x-ndjson"))
      result = workspaceResultSchema.parse(await response.json());
    else {
      if (!response.body) throw failed("Missing command stream");
      result = await readStream(response.body, failed, (text) => {
        output += text;
        if (command) emit({ type: "command_delta", id, text });
      });
    }
    if (!result) throw failed("Command stream ended without a result");
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
