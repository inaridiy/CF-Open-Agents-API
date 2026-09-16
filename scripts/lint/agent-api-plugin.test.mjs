import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it, test } from "node:test";
import { fileURLToPath } from "node:url";

import { RuleTester } from "oxlint/plugins-dev";

import plugin, { DEFAULT_ENTRYPOINTS, ENTRYPOINT_MARKER } from "./agent-api-plugin.mjs";

/**
 * The rules are exercised two ways: through oxlint's `RuleTester` for each rule's
 * semantics, and through the oxlint CLI with a throwaway config that loads the plugin the
 * way `oxlint.config.ts` does, to prove the file-relative allow-lists hold under the
 * linter's own working directory.
 */
RuleTester.describe = (text, fn) => {
  void describe(text, fn);
};
RuleTester.it = (text, fn) => {
  void it(text, fn);
};
const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const ROOT = "/repo";
/**
 * @param {string} filename
 * @param {string} code
 */
const at = (filename, code) => ({ code, filename, cwd: ROOT });

tester.run("no-run-in-transaction", plugin.rules["no-run-in-transaction"], {
  valid: [
    "repo.transaction((tx) => tx.save(record));",
    "yield* repo.read((tx) => tx.session());",
    "storage.transactionSync(() => store.put(kind, id, value));",
    "const value = runSync(program); repo.transaction((tx) => tx.save(value));",
    "reader.read((chunk) => Effect.runSync(consume(chunk)));",
    "Effect.runPromise(repo.transaction((tx) => tx.commands(1)));",
  ],
  invalid: [
    {
      code: "repo.transaction((tx) => Effect.runSync(tx.thing()));",
      errors: [{ messageId: "runner", data: { callee: "Effect.runSync", method: "transaction" } }],
    },
    {
      code: "this.ctx.storage.transactionSync(function () { return runPromise(program); });",
      errors: [{ messageId: "runner", data: { callee: "runPromise", method: "transactionSync" } }],
    },
    {
      code: "tick.repo.read((tx) => { const f = () => runtime.runPromiseExit(program); return f(); });",
      errors: [{ messageId: "runner", data: { callee: "runtime.runPromiseExit", method: "read" } }],
    },
    {
      code: "db.transaction(() => { this.runtime.runFork(program); });",
      errors: [
        { messageId: "runner", data: { callee: "this.runtime.runFork", method: "transaction" } },
      ],
    },
  ],
});

tester.run("no-run-below-entrypoint", plugin.rules["no-run-below-entrypoint"], {
  valid: [
    at("packages/agent-api/src/service.ts", "// lint: entrypoint\nreturn runPromise(program);"),
    at(
      "packages/agent-api/src/http/sessions.ts",
      "app.get('/x', async (c) => {\n  // lint: entrypoint\n  const value = await runPromise(program);\n  return value;\n});",
    ),
    at(
      "packages/agent-api/src/session.ts",
      "class S {\n  /** doc */\n  // lint: entrypoint\n  private readonly wake = runSync(PubSub.sliding(1));\n}",
    ),
    at(
      "packages/agent-api/src/effect.ts",
      "export const decode = (schema, input) =>\n  // lint: entrypoint\n  runSync(decodeEffect(schema, input));",
    ),
    at("packages/agent-api/src/session-state.ts", "const run = (tx) => tx.save(record);"),
    at("packages/agent-api/src/runtime.ts", "const runner = { runPromise: 1 };"),
    // A custom allow-list replaces the default one.
    {
      ...at("packages/agent-api/src/custom.ts", "// boundary\nrunSync(program);"),
      options: [{ entrypoints: ["packages/agent-api/src/custom.ts"], marker: "boundary" }],
    },
  ],
  invalid: [
    {
      ...at("packages/agent-api/src/session-state.ts", "const value = runSync(program);"),
      errors: [
        {
          messageId: "below",
          data: { callee: "runSync", file: "packages/agent-api/src/session-state.ts" },
        },
      ],
    },
    {
      ...at(
        "packages/agent-api/src/models/body.ts",
        "export const read = (r) => runPromise(effect(r));",
      ),
      errors: [{ messageId: "below" }],
    },
    {
      ...at("packages/agent-api/src/vaults.ts", "await Effect.runPromise(program);"),
      errors: [
        {
          messageId: "below",
          data: { callee: "Effect.runPromise", file: "packages/agent-api/src/vaults.ts" },
        },
      ],
    },
    {
      ...at("packages/agent-api/src/session-reconcile.ts", "runtime.runFork(program);"),
      errors: [{ messageId: "below" }],
    },
    // An entrypoint file still needs the marker on the line directly above.
    {
      ...at("packages/agent-api/src/service.ts", "return runPromise(program);"),
      errors: [
        { messageId: "unmarked", data: { callee: "runPromise", marker: ENTRYPOINT_MARKER } },
      ],
    },
    {
      ...at(
        "packages/agent-api/src/service.ts",
        "// lint: entrypoint\nconst x = 1;\nreturn runPromise(program);",
      ),
      errors: [{ messageId: "unmarked" }],
    },
    {
      ...at("packages/agent-api/src/service.ts", "return runPromise(program); // lint: entrypoint"),
      errors: [{ messageId: "unmarked" }],
    },
    {
      ...at(
        "packages/agent-api/src/containers.ts",
        "class C {\n  run(p) {\n    return this.runtime.runPromiseExit(p).then(settle);\n  }\n}",
      ),
      errors: [
        {
          messageId: "unmarked",
          data: { callee: "this.runtime.runPromiseExit", marker: ENTRYPOINT_MARKER },
        },
      ],
    },
    // A marker covers exactly one call.
    {
      ...at(
        "packages/agent-api/src/http/files.ts",
        "// lint: entrypoint\nawait runPromise(a);\nawait runPromise(b);",
      ),
      errors: [{ messageId: "unmarked", line: 3 }],
    },
    // A file outside the allow-list is not rescued by the marker.
    {
      ...at("packages/agent-api/src/skills.ts", "// lint: entrypoint\nrunSync(program);"),
      errors: [{ messageId: "below" }],
    },
  ],
});

tester.run("no-api-error-construction", plugin.rules["no-api-error-construction"], {
  valid: [
    at(
      "packages/agent-api/src/errors.ts",
      "export const toApiError = (e) => new ApiError(400, e.code, e.message);",
    ),
    at("packages/agent-api/src/api-error.ts", "return new ApiError(status, code, message);"),
    at("packages/agent-api/src/service.ts", "return yield* new InvalidRequest({ issues });"),
    at("packages/agent-api/src/service.ts", "throw toApiError(error);"),
    {
      ...at("packages/agent-api/src/wire.ts", "new ApiError(400, 'x', 'y');"),
      options: [{ modules: ["packages/agent-api/src/wire.ts"] }],
    },
  ],
  invalid: [
    {
      ...at(
        "packages/agent-api/src/service.ts",
        "throw new ApiError(400, 'invalid_request', 'bad');",
      ),
      errors: [{ messageId: "construct" }],
    },
    {
      ...at(
        "packages/agent-api/src/http/sessions.ts",
        "return Effect.fail(new ApiError(409, 'conflict', 'x'));",
      ),
      errors: [{ messageId: "construct" }],
    },
  ],
});

void test("the default allow-list names files and directories that exist in the Worker package", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
  for (const pattern of DEFAULT_ENTRYPOINTS) {
    const path = pattern.endsWith("*.ts") ? dirname(pattern) : pattern;
    assert.ok(existsSync(join(root, path)), `${pattern}: ${path} is missing`);
  }
});

/**
 * The CLI path: a throwaway repository with the same layout, a JSON config that loads the
 * plugin by absolute path and enables the three rules, and `oxlint -f json` run from that
 * root so `context.cwd` is the one the allow-lists are relative to.
 * @param {import("node:test").TestContext} t
 */
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "cf-agent-api-lint-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pluginPath = fileURLToPath(new URL("./agent-api-plugin.mjs", import.meta.url));
  writeFileSync(
    join(root, "oxlint.json"),
    JSON.stringify({
      jsPlugins: [pluginPath],
      rules: {
        "agent-api/no-run-in-transaction": "error",
        "agent-api/no-run-below-entrypoint": "error",
        "agent-api/no-api-error-construction": "error",
      },
    }),
  );
  /**
   * @param {string} path
   * @param {string} code
   */
  const write = (path, code) => {
    mkdirSync(join(root, dirname(path)), { recursive: true });
    writeFileSync(join(root, path), code);
  };
  const oxlint = join(dirname(fileURLToPath(import.meta.url)), "../../node_modules/.bin/oxlint");
  const lint = () => {
    const result = spawnSync(oxlint, ["--config", "oxlint.json", "-f", "json", "."], {
      cwd: root,
      encoding: "utf8",
    });
    const report =
      /** @type {{ diagnostics: { filename: string, code: string, labels?: { span: { line: number } }[] }[] }} */ (
        JSON.parse(result.stdout)
      );
    return report.diagnostics
      .map((d) => `${d.filename}:${d.labels?.[0]?.span.line ?? 0} ${d.code}`)
      .sort();
  };
  return { write, lint };
}

void test("the CLI loads the plugin and applies the allow-lists relative to its working directory", (t) => {
  const { write, lint } = fixture(t);
  write(
    "packages/agent-api/src/http/agents.ts",
    [
      "export const handler = async () => {",
      "  // lint: entrypoint",
      "  await runPromise(program);",
      "  await runPromise(program);",
      "  repo.transaction((tx) => Effect.runSync(tx.thing()));",
      "  throw new ApiError(400, 'x', 'y');",
      "};",
      "",
    ].join("\n"),
  );
  write(
    "packages/agent-api/src/models/body.ts",
    "export const read = () => Effect.runSync(program);\n",
  );
  write(
    "packages/agent-api/src/errors.ts",
    "export const wire = () => new ApiError(400, 'x', 'y');\n",
  );
  assert.deepEqual(lint(), [
    "packages/agent-api/src/http/agents.ts:4 agent-api(no-run-below-entrypoint)",
    "packages/agent-api/src/http/agents.ts:5 agent-api(no-run-below-entrypoint)",
    "packages/agent-api/src/http/agents.ts:5 agent-api(no-run-in-transaction)",
    "packages/agent-api/src/http/agents.ts:6 agent-api(no-api-error-construction)",
    "packages/agent-api/src/models/body.ts:1 agent-api(no-run-below-entrypoint)",
  ]);
});
