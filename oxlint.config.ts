import { defineConfig, type OxlintConfig } from "oxlint";
import core from "ultracite/oxlint/core";

/**
 * Ultracite's core preset carries ~540 rules, most of them stylistic (sort-keys, curly,
 * func-style). This repository keeps the correctness subset as errors and a few quality
 * families as warnings; run `pnpm lint` (type-aware) before committing.
 */
type RuleMap = NonNullable<OxlintConfig["rules"]>;
const pick = <K extends string>(source: { rules?: RuleMap }, names: readonly K[]) => {
  const selected = {} as { [P in K]: RuleMap[P] };
  for (const name of names) {
    const rule = source.rules?.[name];
    if (rule === undefined) throw new Error(`Installed Ultracite preset is missing rule: ${name}`);
    selected[name] = rule;
  }
  return selected;
};

const ERRORS = [
  "no-async-promise-executor",
  "no-unsafe-finally",
  "no-unsafe-negation",
  "no-unsafe-optional-chaining",
  "no-self-compare",
  "no-self-assign",
  "no-dupe-keys",
  "no-dupe-else-if",
  "no-dupe-class-members",
  "no-constant-condition",
  "no-constant-binary-expression",
  "no-cond-assign",
  "no-fallthrough",
  "no-unreachable",
  "no-unreachable-loop",
  "no-useless-catch",
  "no-useless-escape",
  "no-var",
  "prefer-const",
  "eqeqeq",
  "no-throw-literal",
  "prefer-promise-reject-errors",
  "no-shadow-restricted-names",
  "no-unused-vars",
  "no-empty",
  "no-param-reassign",
  "typescript/await-thenable",
  "typescript/no-floating-promises",
  "typescript/no-misused-promises",
  "typescript/switch-exhaustiveness-check",
  "typescript/no-unnecessary-type-assertion",
  "typescript/no-array-delete",
  "typescript/no-base-to-string",
  "typescript/no-for-in-array",
  "typescript/no-implied-eval",
  "typescript/no-misused-new",
  "typescript/no-misused-spread",
  "typescript/no-non-null-asserted-optional-chain",
  "typescript/no-non-null-assertion",
  "typescript/no-unsafe-declaration-merging",
  "typescript/no-unsafe-enum-comparison",
  "typescript/only-throw-error",
  "typescript/prefer-promise-reject-errors",
  "typescript/restrict-template-expressions",
  "typescript/no-explicit-any",
  "typescript/consistent-type-imports",
  "typescript/no-unnecessary-type-conversion",
  "unicorn/no-unnecessary-await",
  "unicorn/no-useless-promise-resolve-reject",
  "unicorn/no-useless-spread",
  "unicorn/no-empty-file",
  "import/no-self-import",
  "import/no-empty-named-blocks",
] as const;

/** Promoted to errors once their findings were cleared (2026-09-15). */
const PROMOTED = [
  "no-shadow",
  "typescript/no-unsafe-argument",
  "typescript/no-unsafe-assignment",
  "typescript/no-unsafe-call",
  "typescript/no-unsafe-member-access",
  "typescript/no-unsafe-return",
  "unicorn/no-useless-undefined",
] as const;
/** Quality families that still carry pre-existing findings; they become errors once clean. */
const WARNINGS = ["no-nested-ternary", "complexity"] as const;

const asWarning = (rules: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(rules).map(([name, rule]) => [
      name,
      Array.isArray(rule) ? ["warn", ...(rule as unknown[]).slice(1)] : "warn",
    ]),
  ) as RuleMap;

export default defineConfig({
  plugins: ["eslint", "typescript", "unicorn", "oxc", "import", "promise"],
  rules: {
    ...pick(core, ERRORS),
    ...pick(core, PROMOTED),
    ...asWarning(pick(core, WARNINGS)),
    "typescript/switch-exhaustiveness-check": [
      "error",
      { considerDefaultExhaustiveForUnions: true },
    ],
    // `== null` is the idiomatic nullish check; everything else must be strict.
    eqeqeq: ["error", "always", { null: "ignore" }],
  } satisfies RuleMap,
  ignorePatterns: [
    ...(core.ignorePatterns ?? []),
    "**/.agents/**",
    "**/.claude/**",
    "**/env.d.ts",
    "**/dist/**",
  ],
});
