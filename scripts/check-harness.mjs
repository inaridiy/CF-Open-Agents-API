import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * @param {string} root
 * @returns {string[]}
 */
export function checkHarness(root) {
  /** @type {string[]} */
  const errors = [];
  /**
   * @param {string} file
   * @returns {string}
   */
  const read = (file) => readFileSync(join(root, file), "utf8");
  const config = /** @type {{ documents: string[], localSkills: string[] }} */ (
    JSON.parse(read(".agents/harness.json"))
  );
  const lock =
    /** @type {{ skills: Record<string, { source?: string, skillPath?: string, computedHash?: string }> }} */ (
      JSON.parse(read("skills-lock.json"))
    );
  const documents = new Set(["AGENTS.md", "CLAUDE.md", ...config.documents]);
  for (const name of readdirSync(join(root, "docs")))
    if (name.endsWith(".md")) documents.add(`docs/${name}`);
  if (read("CLAUDE.md").trim() !== "@AGENTS.md") errors.push("CLAUDE.md must import @AGENTS.md");
  for (const file of documents) {
    const markdown = read(file).replace(/^```[^\n]*\n[\s\S]*?^```\s*$/gm, "");
    for (const match of markdown.matchAll(/\[[^\]]*\]\(([^\s)]+)\)/g)) {
      const target = match[1];
      if (/^(?:[a-z][a-z\d+.-]*:|#)/i.test(target)) continue;
      const path = decodeURIComponent(target.split(/[?#]/)[0]);
      if (!existsSync(resolve(root, dirname(file), path)))
        errors.push(`${file}: missing linked file ${target}`);
    }
  }
  const names = readdirSync(join(root, ".agents/skills"));
  for (const name of names) {
    const directory = join(root, ".agents/skills", name);
    const alias = join(root, ".claude/skills", name);
    if (!existsSync(join(directory, "SKILL.md"))) errors.push(`${name}: missing SKILL.md`);
    if (!existsSync(alias) || realpathSync(alias) !== realpathSync(directory))
      errors.push(`${name}: missing or incorrect Claude alias`);
    if (!config.localSkills.includes(name)) {
      const provenance = lock.skills[name];
      if (!provenance?.source || !provenance.skillPath || !provenance.computedHash)
        errors.push(`${name}: missing upstream provenance`);
      if (!existsSync(join(directory, "LICENSE"))) errors.push(`${name}: missing upstream LICENSE`);
    }
  }
  for (const name of [...Object.keys(lock.skills), ...readdirSync(join(root, ".claude/skills"))])
    if (!names.includes(name)) errors.push(`${name}: stale skill entry`);
  return errors;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const errors = checkHarness(process.cwd());
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  } else console.log("Project documentation links, agent entrypoints, skills and licenses agree.");
}
