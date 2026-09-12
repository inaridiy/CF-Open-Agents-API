import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/harnesses/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
});
