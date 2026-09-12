import { serve } from "@hono/node-server";
import { z } from "zod";
import { createSupervisor } from "./server.js";

const config = z
  .object({
    PORT: z.coerce.number().int().min(1).max(65_535).default(8080),
    CODEX_BINARY: z.string().default("codex"),
    STATE_DIRECTORY: z.string().default("/app/state"),
    MODEL_BASE_URL: z.url().default("http://model.internal/v1"),
    SANDBOX_URL: z.url().default("ws://sandbox.internal"),
  })
  .parse(process.env);
const supervisor = createSupervisor({
  binary: config.CODEX_BINARY,
  directory: config.STATE_DIRECTORY,
  modelBaseUrl: config.MODEL_BASE_URL,
  sandboxUrl: config.SANDBOX_URL,
  diagnostics: (line) => console.error(line),
});
const server = serve({ fetch: supervisor.app.fetch, port: config.PORT });
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    void supervisor.stop().finally(() => server.close());
  });
}
