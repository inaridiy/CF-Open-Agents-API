import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative } from "node:path";

import type { StepResult } from "./plan.js";

export function readIfExists(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

/** Forward-slash path relative to the project, for the report. */
export function display(root: string, path: string): string {
  return relative(root, path).split("\\").join("/") || ".";
}

/**
 * The project's files. Writes happen only when content differs; a dry run keeps them in
 * an overlay so later steps see what earlier steps would have written.
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
    if (this.dryRun) this.overlay.set(path, content);
    else {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
    }
    return {
      status: current === undefined ? "created" : "updated",
      file,
      ...(note ? { note } : {}),
    };
  }
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
