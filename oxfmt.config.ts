import { defineConfig } from "oxfmt";
import ultracite from "ultracite/oxfmt";

export default defineConfig({
  ...ultracite,
  printWidth: 100,
  proseWrap: "preserve",
  overrides: [
    // Wrangler and the docs checker read these with JSON.parse: no trailing commas.
    { files: ["**/*.jsonc", "**/*.json"], options: { trailingComma: "none" } },
  ],
  trailingComma: "all",
  ignorePatterns: [
    ...(ultracite.ignorePatterns ?? []),
    "**/.agents/**",
    "**/.claude/**",
    "**/env.d.ts",
    "**/dist/**",
    // Fixture projects the setup CLI is tested against and the files its tests render.
    "**/test/fixtures/**",
    "**/test/.tmp-*/**",
    "**/.wrangler/**",
    // Preserve the unmodified, model-generated artifact shown in the launch film.
    "video/public/demo/**",
  ],
});
