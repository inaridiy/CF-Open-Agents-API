import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, it } from "vitest";

import { ensurePnpmBuilds, Files, runInit } from "../src/index.js";
import { cleanup, emptyDirectory, offline, read, silent } from "./helpers.js";

const yaml = "pnpm-workspace.yaml";

it("creates pnpm-workspace.yaml with the esbuild and workerd approvals", () => {
  const dir = emptyDirectory();
  try {
    const result = ensurePnpmBuilds(new Files(dir, false), "pnpm");
    expect(result.status).toBe("created");
    expect(read(dir, yaml)).toBe("allowBuilds:\n  esbuild: true\n  workerd: true\n");
    expect(ensurePnpmBuilds(new Files(dir, false), "pnpm").status).toBe("skipped");
  } finally {
    cleanup(dir);
  }
});

it("does nothing for npm, yarn and bun projects", () => {
  const dir = emptyDirectory();
  try {
    for (const manager of ["npm", "yarn", "bun"] as const)
      expect(ensurePnpmBuilds(new Files(dir, false), manager).status).toBe("skipped");
    expect(() => read(dir, yaml)).toThrow();
  } finally {
    cleanup(dir);
  }
});

it("inserts missing entries under an existing allowBuilds block and keeps the rest", () => {
  const dir = emptyDirectory();
  try {
    writeFileSync(
      join(dir, yaml),
      "packages:\n  - apps/*\nallowBuilds:\n  esbuild: true\n  sharp: false\nminimumReleaseAge: 1440\n",
    );
    const result = ensurePnpmBuilds(new Files(dir, false), "pnpm");
    expect(result.status).toBe("updated");
    expect(read(dir, yaml)).toBe(
      "packages:\n  - apps/*\nallowBuilds:\n  workerd: true\n  esbuild: true\n  sharp: false\nminimumReleaseAge: 1440\n",
    );
  } finally {
    cleanup(dir);
  }
});

it("appends an allowBuilds block to a file without one", () => {
  const dir = emptyDirectory();
  try {
    writeFileSync(join(dir, yaml), "packages:\n  - apps/*\n\n");
    expect(ensurePnpmBuilds(new Files(dir, false), "pnpm").status).toBe("updated");
    expect(read(dir, yaml)).toBe(
      "packages:\n  - apps/*\nallowBuilds:\n  esbuild: true\n  workerd: true\n",
    );
  } finally {
    cleanup(dir);
  }
});

it("accepts the pnpm 10 onlyBuiltDependencies list as approval", () => {
  const dir = emptyDirectory();
  try {
    const before = "onlyBuiltDependencies:\n  - esbuild\n  - workerd\n";
    writeFileSync(join(dir, yaml), before);
    expect(ensurePnpmBuilds(new Files(dir, false), "pnpm").status).toBe("skipped");
    expect(read(dir, yaml)).toBe(before);
  } finally {
    cleanup(dir);
  }
});

it("leaves a workspace member alone and points at the workspace root", () => {
  const root = emptyDirectory();
  try {
    writeFileSync(join(root, yaml), "packages:\n  - apps/*\n");
    const member = join(root, "apps", "worker");
    mkdirSync(member, { recursive: true });
    const result = ensurePnpmBuilds(new Files(member, false), "pnpm");
    expect(result.status).toBe("skipped");
    expect(result.note).toContain(join(root, yaml));
    expect(() => read(member, yaml)).toThrow();
  } finally {
    cleanup(root);
  }
});

it("init under pnpm dlx writes the approval and pnpm next steps", async () => {
  const dir = emptyDirectory();
  try {
    const notes: string[] = [];
    const reporter = { ...silent(), note: (text: string) => notes.push(text) };
    const { plan, project } = await runInit({
      dir,
      yes: true,
      force: false,
      dryRun: false,
      env: { ...offline, npm_config_user_agent: "pnpm/11.1.2 npm/? node/v24.15.0 linux x64" },
      reporter,
      token: () => "t".repeat(40),
    });
    expect(project.packageManager).toBe("pnpm");
    expect(plan.created).toContain(yaml);
    expect(read(dir, yaml)).toBe("allowBuilds:\n  esbuild: true\n  workerd: true\n");
    expect(notes.join("\n")).toContain("1. pnpm install");
  } finally {
    cleanup(dir);
  }
});
