import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative } from "node:path";

import type { StepResult } from "./plan.js";

export function readIfExists(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

/** Forward-slash path relative to the project, for the report and for wrangler arguments. */
export function display(root: string, path: string): string {
  return relative(root, path).split("\\").join("/") || ".";
}

/**
 * Appends a block to a file's lines, dropping trailing blanks first, so the joined text ends
 * in exactly one newline. `separate` puts one blank line between what was there and the
 * block; a list the block extends does not. An empty block only trims.
 */
export function appendBlock(lines: string[], block: readonly string[], separate = true): string[] {
  while (lines.length > 0 && lines.at(-1) === "") lines.pop();
  if (block.length === 0) return lines;
  if (separate && lines.length > 0) lines.push("");
  lines.push(...block);
  return lines;
}

/**
 * The project's files, as an overlay. Every step computes against it and later steps see
 * what earlier ones would have written, so a run that refuses a conflict leaves the project
 * untouched: nothing reaches disk until `flush`, and a dry run never flushes. Content that
 * already matches is not a write at all.
 */
export class Files {
  private readonly overlay = new Map<string, string>();

  constructor(
    readonly root: string,
    readonly dryRun: boolean,
  ) {}

  read(path: string): string | undefined {
    return this.overlay.get(path) ?? readIfExists(path);
  }

  exists(path: string): boolean {
    return this.overlay.has(path) || existsSync(path);
  }

  write(path: string, content: string, note?: string): StepResult {
    const file = display(this.root, path);
    const current = this.read(path);
    if (current === content) return { status: "skipped", file };
    this.overlay.set(path, content);
    return {
      status: current === undefined ? "created" : "updated",
      file,
      ...(note ? { note } : {}),
    };
  }

  /** Writes everything computed so far, in the order the steps produced it. */
  flush(): void {
    if (this.dryRun) return;
    for (const [path, content] of this.overlay) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
    }
  }
}

/**
 * A file the template owns but the user may have edited: an edited file is kept, and only
 * `--force` writes the template over it. `undefined` means there is nothing to keep.
 */
export function keepUnlessForce(
  files: Files,
  path: string,
  content: string,
  force: boolean,
): (StepResult & { note: string }) | undefined {
  const existing = files.read(path);
  if (existing === undefined || existing === content || force) return;
  const file = display(files.root, path);
  return {
    status: "skipped",
    file,
    note: `${file} exists with different content and was kept; --force rewrites it from the template.`,
  };
}

export interface Formatting {
  insertSpaces: boolean;
  tabSize: number;
  eol: "\n" | "\r\n";
}
/** Indentation and line endings of an existing file, so edits match it. */
export function detectFormatting(text: string): Formatting {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const indent = /^(?:\r?\n)*[^\n]*\r?\n( +|\t)\S/.exec(text)?.[1];
  if (indent === "\t") return { insertSpaces: false, tabSize: 2, eol };
  return { insertSpaces: true, tabSize: indent ? indent.length : 2, eol };
}
