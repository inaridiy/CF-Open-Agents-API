import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

const bundleSchema = z.strictObject({
  version: z.literal(1),
  threadId: z.string(),
  files: z.record(z.string(), z.string()),
});
export type NativeBundle = z.infer<typeof bundleSchema>;
const MAX_BYTES = 32 * 1024 * 1024;

/** Call only after the app-server exits, so SQLite/WAL files are quiescent. */
export async function capture(home: string, threadId: string): Promise<NativeBundle> {
  const files: Record<string, string> = {};
  let bytes = 0;
  async function visit(relative: string): Promise<void> {
    for (const entry of await readdir(join(home, relative), { withFileTypes: true })) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (["config.toml", "environments.toml", "auth.json", "logs", "log", "tmp"].includes(path))
        continue;
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) {
        const data = await readFile(join(home, path));
        bytes += data.length;
        if (bytes > MAX_BYTES) throw new Error("Native checkpoint exceeds 32 MiB");
        files[path] = Buffer.from(data).toString("base64");
      }
    }
  }
  await visit("");
  return { version: 1, threadId, files };
}

export async function restore(home: string, value: unknown): Promise<string> {
  const bundle = bundleSchema.parse(value);
  let bytes = 0;
  const entries = Object.entries(bundle.files).map(([path, encoded]) => {
    if (
      path.startsWith("/") ||
      path.includes("\\") ||
      path.split("/").some((p) => !p || p === "." || p === "..")
    )
      throw new Error("Invalid checkpoint path");
    const data = Buffer.from(encoded, "base64");
    bytes += data.length;
    if (bytes > MAX_BYTES) throw new Error("Native checkpoint exceeds 32 MiB");
    return { path, data };
  });
  for (const { path, data } of entries) {
    await mkdir(join(home, path, ".."), { recursive: true });
    await writeFile(join(home, path), data, { mode: 0o600 });
  }
  return bundle.threadId;
}
