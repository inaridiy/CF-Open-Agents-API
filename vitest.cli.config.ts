import { defineConfig } from "vitest/config";

/** The setup CLI runs in Node; its tests import the source and drive the built `dist/cli.js` against fixture projects. */
export default defineConfig({
  test: {
    include: ["packages/create-cf-open-agents-api/test/**/*.test.ts"],
    testTimeout: 60_000,
  },
});
