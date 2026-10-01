import { defineConfig } from "vitest/config";

/** The durable-machine package's own tests run in Node; its SQLite store is exercised in workerd by `pnpm test`. */
export default defineConfig({
  test: { include: ["packages/durable-machine/test/**/*.test.ts"] },
});
