import type { ISandbox } from "@cloudflare/sandbox";
import { workspacePath, workspaceRequestSchema, workspaceTools } from "./workspace.js";

export async function executeWorkspaceTool(
  sandbox: ISandbox,
  request: unknown,
  options?: { onOutput(text: string): void; signal: AbortSignal },
): Promise<{ text: string; exitCode: number | null }> {
  const input = workspaceRequestSchema.parse(request);
  if (input.tool === "bash") {
    const args = workspaceTools.bash.schema.parse(input.arguments);
    const process = await sandbox.exec(["bash", "-lc", args.command], {
      cwd: args.workdir,
      timeout: args.timeout,
    });
    if (options) {
      let exited = false;
      let text = "";
      const decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() };
      let bytes = 0;
      const signal = AbortSignal.any([options.signal, AbortSignal.timeout(args.timeout + 1000)]);
      try {
        const logs = await process.logs({ follow: true, replay: true, signal });
        const reader = logs.getReader();
        try {
          for (;;) {
            const event = await reader.read();
            if (event.done) throw new Error("Command log ended before terminal outcome");
            const value = event.value;
            if (value.type === "stdout" || value.type === "stderr") {
              bytes += value.data.byteLength;
              if (bytes > 1_000_000) throw new Error("Sandbox command output exceeds 1 MB");
              const delta = decoders[value.type].decode(value.data, { stream: true });
              text += delta;
              if (delta) options.onOutput(delta);
            } else if (value.type === "terminal" && value.state === "exited") {
              exited = true;
              const tail = decoders.stdout.decode() + decoders.stderr.decode();
              if (tail) options.onOutput(tail);
              return { text: text + tail, exitCode: value.exit.code };
            } else throw new Error("Sandbox command log failed or was truncated");
          }
        } finally {
          await reader.cancel();
        }
      } finally {
        if (!exited) await process.kill(9);
      }
    }
    const result = await process.output({
      encoding: "utf8",
      maxBytes: 1_000_000,
      timeout: args.timeout + 1000,
    });
    if (result.truncated || result.timedOut)
      throw new Error("Sandbox command output or time limit exceeded");
    return { text: result.stdout + result.stderr, exitCode: result.exitCode };
  }
  if (input.tool === "write") {
    const args = workspaceTools.write.schema.parse(input.arguments);
    const path = workspacePath(args.file_path);
    await sandbox.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
    await sandbox.writeFile(path, args.content);
    return { text: `Wrote ${path}`, exitCode: null };
  }
  if (input.tool === "read") {
    const args = workspaceTools.read.schema.parse(input.arguments);
    const result = await sandbox.readFile(workspacePath(args.file_path));
    if (result.content.length > 1_000_000) throw new Error("File exceeds the 1 MB read limit");
    const text = result.content
      .split("\n")
      .slice(args.offset - 1, args.offset - 1 + args.limit)
      .join("\n");
    return { text, exitCode: null };
  }
  const args = workspaceTools.edit.schema.parse(input.arguments);
  const path = workspacePath(args.file_path);
  const result = await sandbox.readFile(path);
  if (result.content.length > 1_000_000) throw new Error("File exceeds the 1 MB edit limit");
  const matches = result.content.split(args.old_string);
  if (matches.length === 1 || (!args.replace_all && matches.length !== 2))
    throw new Error("The original string must match exactly once");
  await sandbox.writeFile(
    path,
    args.replace_all
      ? matches.join(args.new_string)
      : result.content.replace(args.old_string, args.new_string),
  );
  return { text: `Edited ${path}`, exitCode: null };
}
