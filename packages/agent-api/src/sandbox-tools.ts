import * as exec from "./containers/exec.js";
import { workspacePath, workspaceRequestSchema, workspaceTools } from "./workspace.js";

interface ToolOptions {
  /** Variables of the sandbox's environment. */
  env: Record<string, string>;
  /** Streams bash output as it arrives. */
  onOutput?: (text: string) => void;
  /** Stops the command and every process it started. */
  signal?: AbortSignal;
}
interface WorkspaceResult {
  text: string;
  exitCode: number | null;
}
const LIMIT = 1_000_000;

async function executeBash(
  target: exec.ExecTarget,
  args: ReturnType<typeof workspaceTools.bash.schema.parse>,
  options: ToolOptions,
): Promise<WorkspaceResult> {
  const result = await exec.run(target, ["bash", "-lc", args.command], {
    cwd: args.workdir,
    env: options.env,
    timeoutMs: args.timeout,
    maxBytes: LIMIT,
    ...(options.onOutput ? { onOutput: options.onOutput } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (result.truncated) throw new Error("Sandbox command output exceeds 1 MB");
  if (result.timedOut) throw new Error("Sandbox command time limit exceeded");
  return { text: result.stdout + result.stderr, exitCode: result.exitCode };
}

/** Runs one workspace tool call against the sandbox container; only SandboxDO calls this. */
export async function executeWorkspaceTool(
  target: exec.ExecTarget,
  request: unknown,
  options: ToolOptions,
): Promise<WorkspaceResult> {
  const input = workspaceRequestSchema.parse(request);
  if (input.tool === "bash")
    return executeBash(target, workspaceTools.bash.schema.parse(input.arguments), options);
  if (input.tool === "write") {
    const args = workspaceTools.write.schema.parse(input.arguments);
    const path = workspacePath(args.file_path);
    await exec.writeFile(target, path, args.content);
    return { text: `Wrote ${path}`, exitCode: null };
  }
  const read = async (path: string, verb: string) => {
    const content = await exec.readText(target, path, LIMIT + 1).catch((error: unknown) => {
      if (error instanceof exec.WorkspaceFileError && error.message.includes("too large"))
        throw new Error(`File exceeds the 1 MB ${verb} limit`);
      throw error;
    });
    if (content.length > LIMIT) throw new Error(`File exceeds the 1 MB ${verb} limit`);
    return content;
  };
  if (input.tool === "read") {
    const args = workspaceTools.read.schema.parse(input.arguments);
    const content = await read(workspacePath(args.file_path), "read");
    const text = content
      .split("\n")
      .slice(args.offset - 1, args.offset - 1 + args.limit)
      .join("\n");
    return { text, exitCode: null };
  }
  const args = workspaceTools.edit.schema.parse(input.arguments);
  const path = workspacePath(args.file_path);
  const content = await read(path, "edit");
  const matches = content.split(args.old_string);
  if (matches.length === 1 || (!args.replace_all && matches.length !== 2))
    throw new Error("The original string must match exactly once");
  await exec.writeFile(
    target,
    path,
    args.replace_all
      ? matches.join(args.new_string)
      : content.replace(args.old_string, args.new_string),
  );
  return { text: `Edited ${path}`, exitCode: null };
}
