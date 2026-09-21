import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, it } from "vitest";

import { ensurePnpmBuilds, Files, runInit } from "../src/index.js";
import { initOptions, offline, read, silent, withEmptyDirectory } from "./helpers.js";

const yaml = "pnpm-workspace.yaml";
/** The overlay only reaches disk on flush; `init` does that once, a unit test per step. */
const flushed = <T>(dir: string, step: (files: Files) => T): T => {
  const files = new Files(dir, false);
  const result = step(files);
  files.flush();
  return result;
};

it("creates pnpm-workspace.yaml with the esbuild and workerd approvals", async () => {
  await withEmptyDirectory(async (dir) => {
    const result = flushed(dir, (files) => ensurePnpmBuilds(files, "pnpm"));
    expect(result.status).toBe("created");
    expect(read(dir, yaml)).toBe("allowBuilds:\n  esbuild: true\n  workerd: true\n");
    expect(ensurePnpmBuilds(new Files(dir, false), "pnpm").status).toBe("skipped");
  });
});

it("does nothing for npm, yarn and bun projects", async () => {
  await withEmptyDirectory(async (dir) => {
    for (const manager of ["npm", "yarn", "bun"] as const)
      expect(ensurePnpmBuilds(new Files(dir, false), manager).status).toBe("skipped");
    expect(() => read(dir, yaml)).toThrow();
  });
});

it("inserts missing entries under an existing allowBuilds block and keeps the rest", async () => {
  await withEmptyDirectory(async (dir) => {
    writeFileSync(
      join(dir, yaml),
      "packages:\n  - apps/*\nallowBuilds:\n  esbuild: true\n  sharp: false\nminimumReleaseAge: 1440\n",
    );
    const result = flushed(dir, (files) => ensurePnpmBuilds(files, "pnpm"));
    expect(result.status).toBe("updated");
    expect(read(dir, yaml)).toBe(
      "packages:\n  - apps/*\nallowBuilds:\n  workerd: true\n  esbuild: true\n  sharp: false\nminimumReleaseAge: 1440\n",
    );
  });
});

it("appends an allowBuilds block to a file without one", async () => {
  await withEmptyDirectory(async (dir) => {
    writeFileSync(join(dir, yaml), "packages:\n  - apps/*\n\n");
    expect(flushed(dir, (files) => ensurePnpmBuilds(files, "pnpm")).status).toBe("updated");
    expect(read(dir, yaml)).toBe(
      "packages:\n  - apps/*\nallowBuilds:\n  esbuild: true\n  workerd: true\n",
    );
  });
});

it("accepts the pnpm 10 onlyBuiltDependencies list as approval", async () => {
  await withEmptyDirectory(async (dir) => {
    const before = "onlyBuiltDependencies:\n  - esbuild\n  - workerd\n";
    writeFileSync(join(dir, yaml), before);
    expect(ensurePnpmBuilds(new Files(dir, false), "pnpm").status).toBe("skipped");
    expect(read(dir, yaml)).toBe(before);
  });
});

it("leaves a workspace member alone and points at the workspace root", async () => {
  await withEmptyDirectory(async (root) => {
    writeFileSync(join(root, yaml), "packages:\n  - apps/*\n");
    const member = join(root, "apps", "worker");
    mkdirSync(member, { recursive: true });
    const result = ensurePnpmBuilds(new Files(member, false), "pnpm");
    expect(result.status).toBe("skipped");
    expect(result.note).toContain(join(root, yaml));
    expect(() => read(member, yaml)).toThrow();
  });
});

it("init under pnpm dlx writes the approval and pnpm next steps", async () => {
  await withEmptyDirectory(async (dir) => {
    const notes: string[] = [];
    const reporter = { ...silent(), note: (text: string) => notes.push(text) };
    const { plan, project } = await runInit(
      initOptions(dir, {
        env: { ...offline, npm_config_user_agent: "pnpm/11.1.2 npm/? node/v24.15.0 linux x64" },
        reporter,
      }),
    );
    expect(project.packageManager).toBe("pnpm");
    expect(plan.created).toContain(yaml);
    expect(read(dir, yaml)).toBe("allowBuilds:\n  esbuild: true\n  workerd: true\n");
    expect(notes.join("\n")).toContain("1. pnpm install");
  });
});
