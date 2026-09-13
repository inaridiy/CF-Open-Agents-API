import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkHarness } from "./check-harness.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "cf-harness-check-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const path of [".agents/skills/provider", ".claude/skills", "docs"])
    mkdirSync(join(root, path), { recursive: true });
  const write = (path, value) => writeFileSync(join(root, path), value);
  write("AGENTS.md", "[Guide](docs/guide.md)\n");
  write("CLAUDE.md", "@AGENTS.md\n");
  write("docs/guide.md", "# Guide\n");
  write(".agents/harness.json", JSON.stringify({ documents: [], localSkills: [] }));
  write(
    "skills-lock.json",
    JSON.stringify({
      skills: {
        provider: { source: "org/provider", skillPath: "SKILL.md", computedHash: "fixture" },
      },
    }),
  );
  write(".agents/skills/provider/SKILL.md", "# Provider\n");
  write(".agents/skills/provider/LICENSE", "Fixture license\n");
  symlinkSync("../../.agents/skills/provider", join(root, ".claude/skills/provider"));
  return { root, write };
}

test("a self-contained checkout validates without a source catalog", (t) => {
  assert.deepEqual(checkHarness(fixture(t).root), []);
});
test("broken documentation and missing distribution evidence fail validation", (t) => {
  const { root, write } = fixture(t);
  write("docs/guide.md", "[Missing guide](gone.md)\n");
  write("skills-lock.json", '{"skills":{}}');
  rmSync(join(root, ".agents/skills/provider/LICENSE"));
  const errors = checkHarness(root).join("\n");
  assert.match(errors, /missing linked file gone.md/);
  assert.match(errors, /missing upstream provenance/);
  assert.match(errors, /missing upstream LICENSE/);
});
test("an alias pointing outside its assigned skill fails validation", (t) => {
  const { root } = fixture(t);
  rmSync(join(root, ".claude/skills/provider"));
  symlinkSync("../../docs", join(root, ".claude/skills/provider"));
  assert.match(checkHarness(root).join("\n"), /incorrect Claude alias/);
});
