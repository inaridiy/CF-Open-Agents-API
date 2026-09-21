import { join } from "node:path";

import { appendBlock, type Files } from "../fs.js";
import type { StepResult } from "../plan.js";
import { MINIMUM_TOKEN_LENGTH, randomToken } from "../token.js";

export interface DevVarsOptions {
  files: Files;
  /** The provider secret to add as an empty line, with the comment that explains it. */
  secret?: { name: string; comment: string };
  token?: () => string;
}

const LOCAL_BACKUPS_COMMENT =
  "# Store sandbox backups on the local R2 emulator during `wrangler dev`; unset in production.";
const TOKEN_COMMENT =
  "# Bearer token clients send; at least 32 characters. A caller must use the same value.";

/** Parses `KEY=value` lines; comments and unknown lines keep their place. */
export function parseDevVars(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (match?.[1] !== undefined) values.set(match[1], (match[2] ?? "").trim());
  }
  return values;
}

function upsertLine(lines: string[], key: string, value: string, comment?: string): void {
  const index = lines.findIndex((line) => new RegExp(`^\\s*${key}\\s*=`).test(line));
  if (index >= 0) {
    lines[index] = `${key}=${value}`;
    return;
  }
  appendBlock(lines, [...(comment ? [comment] : []), `${key}=${value}`]);
}

/** `.dev.vars` with a usable API token, the provider key line and local backups. */
export function ensureDevVars(options: DevVarsOptions): StepResult {
  const path = join(options.files.root, ".dev.vars");
  const existing = options.files.read(path) ?? "";
  const values = parseDevVars(existing);
  const lines = appendBlock(existing.split(/\r?\n/), []);
  const notes: string[] = [];
  const token = values.get("API_TOKEN") ?? "";
  if (token.length < MINIMUM_TOKEN_LENGTH) {
    upsertLine(lines, "API_TOKEN", (options.token ?? randomToken)(), TOKEN_COMMENT);
    if (token)
      notes.push(
        `.dev.vars: API_TOKEN was shorter than ${MINIMUM_TOKEN_LENGTH} characters and was replaced.`,
      );
  }
  if (options.secret && !values.has(options.secret.name))
    upsertLine(lines, options.secret.name, "", options.secret.comment);
  if (!values.has("LOCAL_BACKUPS"))
    upsertLine(lines, "LOCAL_BACKUPS", "true", LOCAL_BACKUPS_COMMENT);
  return options.files.write(
    path,
    `${lines.join("\n")}\n`,
    notes.length > 0 ? notes.join(" ") : undefined,
  );
}

/** The committed example next to `.dev.vars`: existing lines stay, missing keys are appended. */
export function ensureDevVarsExample(options: DevVarsOptions): StepResult {
  const path = join(options.files.root, ".dev.vars.example");
  const existing = options.files.read(path) ?? "";
  const values = parseDevVars(existing);
  const lines = appendBlock(existing.split(/\r?\n/), []);
  const append = (block: readonly string[]) => appendBlock(lines, block, false);
  if (!values.has("API_TOKEN")) append(["API_TOKEN=replace-with-at-least-32-random-characters"]);
  if (options.secret && !values.has(options.secret.name))
    append([options.secret.comment, `${options.secret.name}=`]);
  if (!values.has("LOCAL_BACKUPS")) append([LOCAL_BACKUPS_COMMENT, "LOCAL_BACKUPS=true"]);
  return options.files.write(path, `${lines.join("\n")}\n`);
}
