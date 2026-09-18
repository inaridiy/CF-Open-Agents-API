import { relative, sep } from "node:path";

/**
 * Repository lint rules for the Worker package, loaded by oxlint as a JS plugin from
 * `oxlint.config.ts` (`jsPlugins`). They enforce the parts of the Effect house rules in
 * `docs/effect.md` that the type checker cannot see:
 *
 * - `agent-api/no-run-in-transaction`: no `Effect.run*`, `runPromise`, `runSync` or
 *   `runtime.run*` call inside a callback passed to `transaction`, `transactionSync` or a
 *   repository's `read`. The callback type already rejects an Effect or a Promise as the
 *   result; this catches a runner hidden inside the body.
 * - `agent-api/no-run-below-entrypoint`: a runner may appear only in the entrypoint files
 *   (route handlers, RPC methods, the alarm, the Promise adapters and the runner module
 *   itself), and only on a line preceded by `// lint: entrypoint`, so every boundary is
 *   visible in the diff and in a grep.
 * - `agent-api/no-api-error-construction`: `new ApiError(...)` is reserved for the error
 *   modules; everything else fails with a tagged domain error, and `toApiError` projects
 *   it to the wire.
 *
 * The rules are syntactic: a runner is recognised by its name (`runPromise`,
 * `runPromiseExit`, `runSync`, `runSyncExit`, `runFork`, `runCallback`) whether it is a
 * bare call or a member of `Effect`, a `ManagedRuntime` or a `Runtime`. Passing a
 * transaction callback by reference (`repo.transaction(handler)`) is not followed.
 */

/**
 * The ESTree fields the rules read; oxlint 1.82 exports no public node types.
 * @typedef {object} AstNode
 * @property {string} type
 * @property {string} [name]
 * @property {boolean} [computed]
 * @property {AstNode} [object]
 * @property {AstNode} [property]
 * @property {AstNode} [callee]
 * @property {AstNode[]} [arguments]
 * @property {AstNode | null} [parent]
 */
/**
 * @typedef {object} Comment
 * @property {string} value
 */
/**
 * @typedef {object} Location
 * @property {{ line: number }} start
 * @property {{ line: number }} end
 */
/**
 * @typedef {object} SourceCode
 * @property {(node: AstNode) => AstNode[]} getAncestors
 * @property {() => Comment[]} getAllComments
 * @property {(node: AstNode | Comment) => Location} getLoc
 */
/**
 * @typedef {object} Diagnostic
 * @property {AstNode} node
 * @property {string} messageId
 * @property {Record<string, string>} [data]
 */
/**
 * @typedef {object} RuleContext
 * @property {string} cwd
 * @property {string} filename
 * @property {readonly unknown[]} options
 * @property {SourceCode} sourceCode
 * @property {(diagnostic: Diagnostic) => void} report
 */
/**
 * @typedef {object} Rule
 * @property {Record<string, unknown>} meta
 * @property {(context: RuleContext) => Record<string, (node: AstNode) => void>} create
 */

const RUNNERS = new Set([
  "runPromise",
  "runPromiseExit",
  "runSync",
  "runSyncExit",
  "runFork",
  "runCallback",
]);
const TRANSACTIONAL = new Set(["transaction", "transactionSync"]);
const REPO_READ = "read";
export const ENTRYPOINT_MARKER = "lint: entrypoint";
/** Files that may run an Effect, relative to the linter's working directory (the repository root). */
export const DEFAULT_ENTRYPOINTS = [
  "packages/agent-api/src/effect.ts",
  "packages/agent-api/src/service.ts",
  "packages/agent-api/src/http/*.ts",
  "packages/agent-api/src/session.ts",
  "packages/agent-api/src/containers.ts",
  "packages/agent-api/src/catalog.ts",
  "packages/agent-api/src/models.ts",
  "packages/agent-api/src/models/gateway.ts",
  "packages/agent-api/src/tools.ts",
];
export const DEFAULT_ERROR_MODULES = [
  "packages/agent-api/src/errors.ts",
  "packages/agent-api/src/api-error.ts",
];

/**
 * The name a call or member expression ends in: `runSync` for both `runSync(...)` and
 * `Effect.runSync(...)`.
 * @param {AstNode | undefined} node
 * @returns {string | undefined}
 */
function lastName(node) {
  if (!node) return;
  if (node.type === "Identifier") return node.name;
  if (node.type === "MemberExpression" && !node.computed && node.property?.type === "Identifier")
    return node.property.name;
  return;
}
/**
 * A readable spelling of the callee: `Effect.runSync`, `this.runtime.runPromiseExit`.
 * @param {AstNode | undefined} node
 * @returns {string}
 */
function render(node) {
  if (!node) return "run";
  if (node.type === "Identifier") return node.name ?? "run";
  if (node.type === "ThisExpression") return "this";
  if (node.type === "MemberExpression" && !node.computed)
    return `${render(node.object)}.${render(node.property)}`;
  return "…";
}
/** @param {AstNode} node */
const calleeText = (node) => render(node.callee);
/** @param {AstNode} node */
function isRunnerCall(node) {
  const name = lastName(node.callee);
  return name !== undefined && RUNNERS.has(name);
}
/**
 * Whether `fn` is an argument of `x.transaction(...)`, `x.transactionSync(...)` or
 * `repo.read(...)` (the receiver's last name contains `repo`); returns the method name.
 * @param {AstNode} fn
 * @returns {string | undefined}
 */
function transactionMethod(fn) {
  const call = fn.parent;
  if (!call || call.type !== "CallExpression" || !call.arguments?.includes(fn)) return;
  const callee = call.callee;
  if (callee?.type !== "MemberExpression" || callee.computed) return;
  const name = lastName(callee);
  if (name === undefined) return;
  if (TRANSACTIONAL.has(name)) return name;
  if (name === REPO_READ && /repo/i.test(lastName(callee.object) ?? "")) return name;
  return;
}
/**
 * Minimal glob: `**` spans directories, `*` and `?` stay within one segment.
 * @param {string} pattern
 */
function globToRegExp(pattern) {
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i] ?? "";
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        source += ".*";
        i++;
        if (pattern[i + 1] === "/") i++;
      } else source += "[^/]*";
    } else if (char === "?") source += "[^/]";
    else source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}
/**
 * The linted file's path relative to the linter's cwd, with forward slashes.
 * @param {RuleContext} context
 */
function relativePath(context) {
  return relative(context.cwd, context.filename).split(sep).join("/");
}
/**
 * @param {string[]} patterns
 * @param {string} path
 */
function matchesAny(patterns, path) {
  return patterns.some((pattern) => globToRegExp(pattern).test(path));
}
/**
 * The last line of every comment that is exactly the marker.
 * @param {RuleContext} context
 * @param {string} marker
 */
function markerLines(context, marker) {
  const lines = new Set();
  for (const comment of context.sourceCode.getAllComments()) {
    if (comment.value.trim() !== marker) continue;
    lines.add(context.sourceCode.getLoc(comment).end.line);
  }
  return lines;
}
/**
 * @param {readonly unknown[]} options
 * @returns {Record<string, unknown>}
 */
const firstOption = (options) =>
  typeof options[0] === "object" && options[0] !== null
    ? /** @type {Record<string, unknown>} */ (options[0])
    : {};
/**
 * @param {unknown} value
 * @param {string[]} fallback
 */
const stringList = (value, fallback) =>
  Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : fallback;

/** @type {Rule} */
const noRunInTransaction = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow Effect runners inside a transaction, transactionSync or repository read callback",
    },
    messages: {
      runner:
        "`{{callee}}` runs an Effect inside a `{{method}}` callback. The callback is one synchronous SQLite step: compute the value outside and pass it in, or return a plain value and yield the Effect after the transaction.",
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        if (!isRunnerCall(node)) return;
        for (const ancestor of context.sourceCode.getAncestors(node)) {
          if (ancestor.type !== "ArrowFunctionExpression" && ancestor.type !== "FunctionExpression")
            continue;
          const method = transactionMethod(ancestor);
          if (method === undefined) continue;
          context.report({ node, messageId: "runner", data: { callee: calleeText(node), method } });
          return;
        }
      },
    };
  },
};

/** @type {Rule} */
const noRunBelowEntrypoint = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Allow Effect runners only in entrypoint files, on a line preceded by `// lint: entrypoint`",
    },
    schema: [
      {
        type: "object",
        properties: {
          entrypoints: { type: "array", items: { type: "string" } },
          marker: { type: "string" },
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [{ entrypoints: DEFAULT_ENTRYPOINTS, marker: ENTRYPOINT_MARKER }],
    messages: {
      below:
        "`{{callee}}` runs an Effect below an entrypoint. Return the Effect and let the route handler, RPC method, alarm or Promise adapter run it; `{{file}}` is not an entrypoint file.",
      unmarked:
        "`{{callee}}` is a boundary runner in an entrypoint file; put `// {{marker}}` on the line above so the exception is visible.",
    },
  },
  create(context) {
    const options = firstOption(context.options);
    const entrypoints = stringList(options.entrypoints, DEFAULT_ENTRYPOINTS);
    const marker = typeof options.marker === "string" ? options.marker : ENTRYPOINT_MARKER;
    const file = relativePath(context);
    const markers = matchesAny(entrypoints, file) ? markerLines(context, marker) : undefined;
    return {
      CallExpression(node) {
        if (!isRunnerCall(node)) return;
        const callee = calleeText(node);
        if (!markers) {
          context.report({ node, messageId: "below", data: { callee, file } });
          return;
        }
        if (markers.has(context.sourceCode.getLoc(node).start.line - 1)) return;
        context.report({ node, messageId: "unmarked", data: { callee, marker } });
      },
    };
  },
};

/** @type {Rule} */
const noApiErrorConstruction = {
  meta: {
    type: "problem",
    docs: { description: "Reserve `new ApiError(...)` for the error modules" },
    schema: [
      {
        type: "object",
        properties: { modules: { type: "array", items: { type: "string" } } },
        additionalProperties: false,
      },
    ],
    defaultOptions: [{ modules: DEFAULT_ERROR_MODULES }],
    messages: {
      construct:
        "`new ApiError(...)` outside the error modules. Fail with a tagged domain error from `errors.ts`; `toApiError` projects it to a status and code, and `caughtFailure` recovers one from a thrown value.",
    },
  },
  create(context) {
    const modules = stringList(firstOption(context.options).modules, DEFAULT_ERROR_MODULES);
    if (matchesAny(modules, relativePath(context))) return {};
    return {
      NewExpression(node) {
        if (node.callee?.type === "Identifier" && node.callee.name === "ApiError")
          context.report({ node, messageId: "construct" });
      },
    };
  },
};

export default {
  meta: { name: "agent-api" },
  rules: {
    "no-run-in-transaction": noRunInTransaction,
    "no-run-below-entrypoint": noRunBelowEntrypoint,
    "no-api-error-construction": noApiErrorConstruction,
  },
};
