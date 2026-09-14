import { serve } from "@hono/node-server";
import { io, runPromise } from "cf-open-agents-api";
import { Config, Effect } from "effect";

import { createSupervisor } from "./server.js";

const config = Config.all({
  port: Config.integer("PORT").pipe(
    Config.withDefault(8080),
    Config.validate({
      message: "PORT must be between 1 and 65535",
      validation: (value) => value >= 1 && value <= 65535,
    }),
  ),
  binary: Config.string("CODEX_BINARY").pipe(Config.withDefault("codex")),
  opencodeBinary: Config.string("OPENCODE_BINARY").pipe(Config.withDefault("opencode")),
  directory: Config.string("STATE_DIRECTORY").pipe(Config.withDefault("/app/state")),
  modelBaseUrl: Config.url("MODEL_BASE_URL").pipe(
    Config.withDefault(new URL("http://model.internal/v1")),
  ),
  sandboxUrl: Config.url("SANDBOX_URL").pipe(Config.withDefault(new URL("ws://sandbox.internal"))),
});
// A stray rejection or exception in a native callback must not take every job's
// transport down with it; the affected job reports its own failure.
process.on("unhandledRejection", (reason) => {
  console.error(`supervisor: unhandled rejection: ${describe(reason)}`);
});
process.on("uncaughtException", (error) => {
  console.error(`supervisor: uncaught exception: ${describe(error)}`);
});
function describe(value: unknown): string {
  return value instanceof Error ? (value.stack ?? value.message) : String(value);
}
const shutdown = Effect.async<void>((resume) => {
  const stop = () => resume(Effect.void);
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  return Effect.sync(() => {
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
  });
});
const program = Effect.scoped(
  Effect.gen(function* () {
    const settings = yield* config;
    const supervisor = createSupervisor({
      ...settings,
      modelBaseUrl: settings.modelBaseUrl.href.replace(/\/$/, ""),
      sandboxUrl: settings.sandboxUrl.href,
      supervisorUrl: `http://127.0.0.1:${settings.port}`,
      diagnostics: (line) => console.error(line),
    });
    yield* Effect.acquireRelease(
      Effect.sync(() => serve({ fetch: supervisor.app.fetch, port: settings.port })),
      (server) =>
        io("supervisor.shutdown", async () => {
          try {
            await supervisor.stop();
          } finally {
            await new Promise<void>((resolve, reject) =>
              server.close((error) => (error ? reject(error) : resolve())),
            );
          }
        }).pipe(Effect.orDie),
    );
    yield* shutdown;
  }),
);
await runPromise(program);
