import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, it } from "vitest";

import { ensureDevVars, ensureDevVarsExample, Files, parseDevVars } from "../src/index.js";
import { read, withEmptyDirectory } from "./helpers.js";

it("parses KEY=value lines and ignores comments", () => {
  const values = parseDevVars("# c\nA=1\n B = two \nnot a line\n");
  expect([...values]).toEqual([
    ["A", "1"],
    ["B", "two"],
  ]);
});

it("keeps comments and unknown lines, replaces a short token and adds the provider key once", async () => {
  await withEmptyDirectory(async (root) => {
    writeFileSync(join(root, ".dev.vars"), "# mine\nOTHER=x\nAPI_TOKEN=short\n");
    const secret = { name: "OPENAI_API_KEY", comment: "# key" };
    const files = new Files(root, false);
    const first = ensureDevVars({ files, secret, token: () => "T".repeat(40) });
    files.flush();
    expect(first.note).toMatch(/shorter than 32/);
    const text = read(root, ".dev.vars");
    expect(text).toMatch(
      /^# mine\nOTHER=x\nAPI_TOKEN=T{40}\n\n# key\nOPENAI_API_KEY=\n\n# Store sandbox backups/,
    );
    expect(text.endsWith("LOCAL_BACKUPS=true\n")).toBe(true);
    const values = parseDevVars(text);
    expect(values.get("OTHER")).toBe("x");
    expect(values.get("LOCAL_BACKUPS")).toBe("true");
  });
});

it("creates the file with a token comment when it is missing", async () => {
  await withEmptyDirectory(async (root) => {
    const files = new Files(root, false);
    ensureDevVars({ files, token: () => "T".repeat(40) });
    files.flush();
    expect(read(root, ".dev.vars")).toMatch(
      /^# Bearer token clients send.*\nAPI_TOKEN=T{40}\n\n# Store sandbox/,
    );
  });
});

it("keeps an existing .dev.vars.example and appends the missing keys", async () => {
  await withEmptyDirectory(async (root) => {
    writeFileSync(join(root, ".dev.vars.example"), "# app\nOTHER=\n");
    const files = new Files(root, false);
    ensureDevVarsExample({ files, secret: { name: "OPENAI_API_KEY", comment: "# key" } });
    files.flush();
    expect(read(root, ".dev.vars.example")).toBe(
      "# app\nOTHER=\nAPI_TOKEN=replace-with-at-least-32-random-characters\n# key\nOPENAI_API_KEY=\n# Store sandbox backups on the local R2 emulator during `wrangler dev`; unset in production.\nLOCAL_BACKUPS=true\n",
    );
  });
});
