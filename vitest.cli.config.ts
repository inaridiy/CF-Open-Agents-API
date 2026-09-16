import { defineConfig } from "vitest/config";

/** The setup CLI runs in Node; its tests drive the built package against fixture projects. */
export default defineConfig({
  test: {
    include: ["packages/create-cf-open-agents-api/test/**/*.test.ts"],
    testTimeout: 60_000,
  },
});
