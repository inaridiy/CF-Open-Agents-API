import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, expect, it } from "vitest";

import {
  type CompositionInput,
  describeSecret,
  HARNESSES,
  PROVIDERS,
  renderComposition,
} from "../src/index.js";
import { packageRoot, repoRoot } from "./helpers.js";

/** Inside the package so the provider packages resolve from its node_modules. */
const directory = mkdtempSync(join(packageRoot, "test", ".tmp-templates-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

const variants: CompositionInput[] = PROVIDERS.flatMap((provider) => [
  { provider, harnesses: HARNESSES, workersAi: false, standalone: true },
  { provider, harnesses: HARNESSES, workersAi: true, standalone: false },
  {
    provider,
    harnesses: ["opencode"],
    workersAi: false,
    standalone: false,
    baseURL: "https://llm.example/v1",
    model: "m",
  },
]);
const fileName = (input: CompositionInput) =>
  `${input.provider}-${input.harnesses.join("+")}-${input.workersAi ? "workers" : "plain"}-${input.standalone ? "entry" : "module"}.ts`;

it("every rendered composition is already formatted", () => {
  mkdirSync(join(directory, "src"), { recursive: true });
  for (const input of variants) {
    const path = join(directory, "src", fileName(input));
    const rendered = renderComposition(input);
    writeFileSync(path, rendered);
    // The rendered directory is ignored by the repository formatter; format the text through stdin instead.
    const formatted = execFileSync(
      join(repoRoot, "node_modules", ".bin", "oxfmt"),
      ["--stdin-filepath", join(repoRoot, "packages", "rendered.ts")],
      { cwd: repoRoot, encoding: "utf8", input: rendered, stdio: "pipe" },
    );
    expect(formatted, fileName(input)).toBe(rendered);
  }
});

it("every rendered composition typechecks against the library", () => {
  writeFileSync(
    join(directory, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2024",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        types: ["@cloudflare/workers-types"],
        paths: {
          "cf-open-agents-api/cloudflare": ["../../../agent-api/dist/cloudflare.d.ts"],
          "cf-open-agents-api/models": ["../../../agent-api/dist/models.d.ts"],
        },
      },
      include: ["src/*.ts"],
    }),
  );
  const tsc = () =>
    execFileSync(join(repoRoot, "node_modules", ".bin", "tsc"), ["-p", directory], {
      cwd: directory,
      encoding: "utf8",
      stdio: "pipe",
    });
  expect(tsc).not.toThrow();
});

it("describes the provider secret with the presets that need it", () => {
  expect(
    describeSecret({ provider: "openai", harnesses: HARNESSES, workersAi: true, standalone: true }),
  ).toEqual({
    name: "OPENAI_API_KEY",
    comment:
      "# Required for the codex, claude and opencode presets; leave empty to use only `workers`.",
  });
  expect(
    describeSecret({
      provider: "anthropic",
      harnesses: ["claude-code"],
      workersAi: false,
      standalone: false,
    }),
  ).toEqual({
    name: "ANTHROPIC_API_KEY",
    comment: "# Required for the claude preset.",
  });
  expect(
    describeSecret({
      provider: "workers-ai",
      harnesses: HARNESSES,
      workersAi: false,
      standalone: false,
    }),
  ).toBeUndefined();
});
