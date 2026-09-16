import {
  applyEdits,
  type JSONPath,
  modify,
  type Node,
  parse,
  type ParseError,
  parseTree,
  printParseErrorCode,
} from "jsonc-parser";

import { detectFormatting, type Formatting } from "./fs.js";
import { CliError } from "./plan.js";

/** A JSONC file kept as text so comments and formatting survive every edit. */
export interface JsoncDocument {
  text: string;
  formatting: Formatting;
}

export function openJsonc(text: string): JsoncDocument {
  return { text, formatting: detectFormatting(text) };
}

export function parseJsonc<T>(text: string, file: string): T {
  const errors: ParseError[] = [];
  const value = parse(text, errors, { allowTrailingComma: true }) as T;
  if (errors.length > 0) {
    const first = errors[0];
    const reason = first ? printParseErrorCode(first.error) : "unknown";
    throw new CliError(`${file} is not valid JSONC (${reason} at offset ${first?.offset ?? 0})`);
  }
  return value;
}

/** Sets a value at a path, creating missing objects; `-1` on an array appends. */
export function setValue(
  document: JsoncDocument,
  path: JSONPath,
  value: unknown,
  insert = false,
): JsoncDocument {
  const edits = modify(document.text, path, value, {
    isArrayInsertion: insert,
    formattingOptions: {
      insertSpaces: document.formatting.insertSpaces,
      tabSize: document.formatting.tabSize,
      eol: document.formatting.eol,
    },
  });
  return { ...document, text: applyEdits(document.text, edits) };
}

export function appendItem(document: JsoncDocument, path: JSONPath, value: unknown): JsoncDocument {
  return setValue(document, [...path, -1], value, true);
}

const isPrimitiveArray = (node: Node): boolean =>
  node.type === "array" &&
  (node.children ?? []).every((child) =>
    ["string", "number", "boolean", "null"].includes(child.type),
  );

const arrays = (node: Node): Node[] =>
  isPrimitiveArray(node) ? [node] : (node.children ?? []).flatMap(arrays);

/**
 * `modify` expands every array in the range it reformats, including neighbours it did
 * not change. Formatters put a short array of scalars on one line, so put those back.
 */
export function collapsePrimitiveArrays(document: JsoncDocument, width = 100): JsoncDocument {
  const root = parseTree(document.text);
  if (!root) return document;
  let text = document.text;
  // Edit from the end so earlier offsets stay valid.
  for (const node of arrays(root).sort((a, b) => b.offset - a.offset)) {
    const items = (node.children ?? []).map((child) =>
      text.slice(child.offset, child.offset + child.length),
    );
    const inline = `[${items.join(", ")}]`;
    const lineStart = text.lastIndexOf("\n", node.offset) + 1;
    if (node.offset - lineStart + inline.length > width) continue;
    text = text.slice(0, node.offset) + inline + text.slice(node.offset + node.length);
  }
  return { ...document, text };
}
