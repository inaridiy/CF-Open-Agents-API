import type { ISandbox } from "@cloudflare/sandbox";
import { parseDocument } from "yaml";
import { z } from "zod";
import { type McpToolConfig, mcpToolSchema } from "./agent-tools.js";

/** Discovery reads bounded metadata only. Skill bodies remain in the Sandbox. */
const discover = `
import json, os, pathlib, sys
roots = json.loads(sys.argv[1]); skills = []; plugins = []; size = 0; count = 0
for configured in roots:
    root = pathlib.Path(configured).resolve(strict=True)
    for directory, dirs, files in os.walk(root, followlinks=False):
        dirs[:] = sorted(d for d in dirs if d not in ['node_modules', '.git'] and not (pathlib.Path(directory)/d).is_symlink())
        count += len(files)
        if count > 10000: raise ValueError('Too many capability files')
        for name in files:
            path = pathlib.Path(directory)/name
            if path.is_symlink(): continue
            if name == 'SKILL.md':
                if path.stat().st_size > 128*1024: raise ValueError('Skill metadata too large')
                content = path.read_text(); size += len(content.encode())
                if size > 2*1024*1024: raise ValueError('Capability metadata too large')
                skills.append({'path':str(path),'content':content})
            if name == 'plugin.json' and path.parent.name in ['.codex-plugin', '.claude-plugin']:
                if path.stat().st_size > 128*1024: raise ValueError('Plugin metadata too large')
                manifest = json.loads(path.read_text()); base = path.parent.parent
                source = manifest.get('mcpServers', '.mcp.json')
                if isinstance(source, str):
                    sourcepath = (base/source).resolve()
                    if not sourcepath.is_relative_to(base): raise ValueError('Plugin MCP path escapes root')
                    if sourcepath.exists():
                        if sourcepath.stat().st_size > 128*1024: raise ValueError('MCP metadata too large')
                        source = json.loads(sourcepath.read_text())
                    else: source = {}
                plugins.append({'name':manifest['name'], 'root':str(base), 'mcp':source.get('mcpServers', source)})
print(json.dumps({'skills':skills, 'plugins':plugins}))
`;
const discoveredSchema = z.object({
  skills: z.array(z.object({ path: z.string(), content: z.string() })).max(1000),
  plugins: z
    .array(
      z.object({
        name: z.string(),
        root: z.string(),
        mcp: z.record(z.string(), z.record(z.string(), z.json())),
      }),
    )
    .max(100),
});
export async function discoverCapabilities(sandbox: ISandbox, roots: readonly string[]) {
  if (!roots.length) return { instructions: "", mcp: [] as McpToolConfig[] };
  const process = await sandbox.exec(["python3", "-c", discover, JSON.stringify(roots)]);
  const result = await process.output({
    timeout: 30_000,
    encoding: "utf8",
    maxBytes: 4 * 1024 * 1024,
  });
  if (result.exitCode !== 0 || result.truncated) throw new Error("Capability discovery failed");
  const found = discoveredSchema.parse(JSON.parse(result.stdout));
  const skills = found.skills.map(({ path, content }) => {
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
    if (!match) throw new Error("Skill frontmatter is missing");
    const yaml = parseDocument(match[1] ?? "", { uniqueKeys: true });
    if (yaml.errors.length) throw new Error("Invalid skill frontmatter");
    const metadata = z
      .object({ name: z.string().min(1).max(256), description: z.string().max(4096) })
      .parse(yaml.toJS({ maxAliasCount: 0 }));
    return { ...metadata, path };
  });
  const mcp = found.plugins.flatMap((plugin) =>
    Object.entries(plugin.mcp).map(([label, value]) => {
      const substitute = (input: unknown): unknown => {
        if (typeof input === "string")
          return input
            .replaceAll(`\${CLAUDE_PLUGIN_ROOT}`, plugin.root)
            .replaceAll(`\${CODEX_PLUGIN_ROOT}`, plugin.root);
        if (Array.isArray(input)) return input.map(substitute);
        if (input && typeof input === "object")
          return Object.fromEntries(
            Object.entries(input).map(([key, value]) => [key, substitute(value)]),
          );
        return input;
      };
      const config = z.record(z.string(), z.json()).parse(substitute(value));
      return mcpToolSchema.parse({
        type: "mcp",
        server_label: `${plugin.name}_${label}`,
        connection_origin: "environment",
        transport: config.url
          ? { type: "http", server_url: config.url, headers: config.headers }
          : {
              type: "stdio",
              command: config.command,
              args: config.args,
              cwd: config.cwd ?? plugin.root,
              env: config.env,
            },
      });
    }),
  );
  return {
    instructions: skills.length
      ? `Available skills in the assigned Sandbox (metadata only):\n${JSON.stringify(skills)}\nWhen a skill applies, read its SKILL.md with the read tool, then follow its instructions. Resolve relative references from that file's directory. Execute scripts with the Sandbox bash tool.`
      : "",
    mcp,
  };
}
