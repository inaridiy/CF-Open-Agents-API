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
                base = path.parent.parent
                try:
                    manifest = json.loads(path.read_text())
                    source = manifest.get('mcpServers', '.mcp.json') if isinstance(manifest, dict) else {}
                    if isinstance(source, str):
                        sourcepath = (base/source).resolve()
                        if not sourcepath.is_relative_to(base): raise ValueError('Plugin MCP path escapes root')
                        if sourcepath.exists():
                            if sourcepath.stat().st_size > 128*1024: raise ValueError('MCP metadata too large')
                            source = json.loads(sourcepath.read_text())
                        else: source = {}
                    servers = source.get('mcpServers', source) if isinstance(source, dict) else {}
                    plugins.append({'name': manifest.get('name') if isinstance(manifest, dict) else None, 'root': str(base), 'mcp': servers if isinstance(servers, dict) else {}, 'error': None})
                except Exception as error:
                    plugins.append({'name': None, 'root': str(base), 'mcp': {}, 'error': str(error)[:512]})
print(json.dumps({'skills':skills, 'plugins':plugins}))
`;
const discoveredSchema = z.object({
  skills: z.array(z.object({ path: z.string(), content: z.string() })).max(1000),
  plugins: z
    .array(
      z.object({
        name: z.unknown(),
        root: z.string(),
        mcp: z.record(z.string(), z.unknown()),
        error: z.string().nullable(),
      }),
    )
    .max(100),
});
const skillMetadataSchema = z.object({
  name: z.string().min(1).max(256),
  description: z.string().max(4096),
});
const LABEL_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/;
const LABEL_LIMIT = 64;

/**
 * Derive an MCP `server_label` from plugin-controlled text. Invalid characters become
 * underscores, the result is truncated to the wire limit and made distinct from every
 * label already taken, so workspace content can add servers but never replace one.
 */
export function sanitizeServerLabel(candidate: string, taken: ReadonlySet<string> = new Set()) {
  let label = candidate.replace(/[^a-zA-Z0-9_]/g, "_");
  if (!/^[a-zA-Z_]/.test(label)) label = `_${label}`;
  label = label.slice(0, LABEL_LIMIT);
  if (!taken.has(label)) return label;
  for (let suffix = 2; ; suffix++) {
    const tail = `_${suffix}`;
    const distinct = `${label.slice(0, LABEL_LIMIT - tail.length)}${tail}`;
    if (!taken.has(distinct)) return distinct;
  }
}
export function isServerLabel(value: string): boolean {
  return LABEL_PATTERN.test(value);
}

export interface DiscoveryOptions {
  /** Labels of configured servers; discovered servers never collide with them. */
  reservedLabels?: readonly string[];
  /** Receives one line per skipped skill or plugin; discovery never fails on content. */
  diagnostics?: (line: string) => void;
}

/**
 * Read skill metadata and plugin MCP definitions from the assigned Sandbox. Malformed
 * entries are skipped with a diagnostic: capability roots are writable by the model, so
 * their contents must not be able to prevent a turn from starting.
 */
export async function discoverCapabilities(
  sandbox: ISandbox,
  roots: readonly string[],
  options: DiscoveryOptions = {},
) {
  if (!roots.length) return { instructions: "", mcp: [] as McpToolConfig[] };
  const diagnostics = options.diagnostics ?? (() => {});
  const process = await sandbox.exec(["python3", "-c", discover, JSON.stringify(roots)]);
  const result = await process.output({
    timeout: 30_000,
    encoding: "utf8",
    maxBytes: 4 * 1024 * 1024,
  });
  if (result.exitCode !== 0 || result.truncated) throw new Error("Capability discovery failed");
  const found = discoveredSchema.parse(JSON.parse(result.stdout));
  const skills = found.skills.flatMap(({ path, content }) => {
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
    if (!match) {
      diagnostics(`skill skipped (missing frontmatter): ${path}`);
      return [];
    }
    try {
      const yaml = parseDocument(match[1] ?? "", { uniqueKeys: true });
      if (yaml.errors.length) throw new Error(yaml.errors[0]?.message ?? "invalid YAML");
      const metadata = skillMetadataSchema.parse(yaml.toJS({ maxAliasCount: 0 }));
      return [{ ...metadata, path }];
    } catch (error) {
      diagnostics(`skill skipped (invalid frontmatter): ${path}: ${String(error)}`);
      return [];
    }
  });
  const taken = new Set(options.reservedLabels ?? []);
  const mcp = found.plugins.flatMap((plugin) => {
    if (plugin.error !== null || typeof plugin.name !== "string" || !plugin.name) {
      diagnostics(`plugin skipped (${plugin.error ?? "missing name"}): ${plugin.root}`);
      return [];
    }
    const name = plugin.name;
    return Object.entries(plugin.mcp).flatMap(([label, value]) => {
      const substitute = (input: unknown): unknown => {
        if (typeof input === "string")
          return input
            .replaceAll(`\${CLAUDE_PLUGIN_ROOT}`, plugin.root)
            .replaceAll(`\${CODEX_PLUGIN_ROOT}`, plugin.root);
        if (Array.isArray(input)) return input.map(substitute);
        if (input && typeof input === "object")
          return Object.fromEntries(
            Object.entries(input).map(([key, entryValue]) => [key, substitute(entryValue)]),
          );
        return input;
      };
      try {
        const config = z.record(z.string(), z.json()).parse(substitute(value));
        const server_label = sanitizeServerLabel(`${name}_${label}`, taken);
        const tool = mcpToolSchema.parse({
          type: "mcp",
          server_label,
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
        taken.add(server_label);
        return [tool];
      } catch (error) {
        diagnostics(`plugin MCP server skipped (${name}/${label}): ${String(error)}`);
        return [];
      }
    });
  });
  return {
    instructions: skills.length
      ? `Available skills in the assigned Sandbox (metadata only):\n${JSON.stringify(skills)}\nWhen a skill applies, read its SKILL.md with the read tool, then follow its instructions. Resolve relative references from that file's directory. Execute scripts with the Sandbox bash tool.`
      : "",
    mcp,
  };
}
