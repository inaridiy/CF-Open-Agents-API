import { Effect } from "effect";

import { runPromise } from "../effect.js";
import { environmentFileSchema, templateSchema } from "../environment-config.js";
import { environmentFilePageSchema } from "../environments.js";
import { EnvironmentDriverUnavailable, EnvironmentNotFound } from "../errors.js";
import { pageSchema, parse } from "../protocol.js";
import type { ServiceOptions } from "../runtime.js";
import { jsonBody, type RouteApp } from "./context.js";

export function registerEnvironmentRoutes<Env>(app: RouteApp<Env>, options: ServiceOptions<Env>) {
  app.post("/v1/agents/environments/templates", async (c) =>
    Response.json(
      await c.env.catalog(c.get("tenant")).createTemplate(parse(templateSchema, await jsonBody(c))),
    ),
  );
  app.get("/v1/agents/environments/templates", async (c) =>
    Response.json(await c.env.catalog(c.get("tenant")).templates(parse(pageSchema, c.req.query()))),
  );
  app.get("/v1/agents/environments/templates/:id", async (c) =>
    Response.json(await c.env.catalog(c.get("tenant")).template(c.req.param("id"))),
  );
  app.post("/v1/agents/environments/templates/:id", async (c) =>
    Response.json(
      await c.env
        .catalog(c.get("tenant"))
        .updateTemplate(c.req.param("id"), parse(templateSchema, await jsonBody(c))),
    ),
  );
  app.delete("/v1/agents/environments/templates/:id", async (c) =>
    Response.json(await c.env.catalog(c.get("tenant")).deleteTemplate(c.req.param("id"))),
  );
  app.get("/v1/agents/environments/:id", async (c) => {
    const spec = await c.env.catalog(c.get("tenant")).environment(c.req.param("id"));
    const stub = await c.env.session(c.get("tenant"), spec.sessionId);
    const session = await stub.retrieve();
    if (session.environment.type !== "openai_hosted")
      throw new EnvironmentNotFound({ environmentId: spec.id });
    const { files, plugins, skills } = session.environment;
    const status = await runPromise(
      options.environments?.(c.env.env).status(spec) ?? Effect.succeed("failed"),
    );
    // A sandbox that went away, or came back after a restore, is reflected as a session event.
    if (status === "disconnected" || status === "connected") await stub.environmentStatus(status);
    return Response.json({
      id: spec.id,
      object: "agent.environment",
      type: "openai_hosted",
      files,
      plugins,
      skills,
      status,
    });
  });
  app.post("/v1/agents/environments/:id/files", async (c) => {
    const spec = await c.env.catalog(c.get("tenant")).environment(c.req.param("id"));
    await c.env.session(c.get("tenant"), spec.sessionId);
    const driver = options.environments?.(c.env.env);
    if (!driver) throw new EnvironmentDriverUnavailable();
    const input = parse(environmentFileSchema, await jsonBody(c));
    if (input.type === "file_id") {
      const file = await c.env.catalog(c.get("tenant")).file(input.file_id);
      spec.inputFiles = {
        ...spec.inputFiles,
        [input.file_id]: { key: file.key, size: file.resource.bytes },
      };
    }
    return Response.json(await runPromise(driver.upload(spec, input)));
  });
  app.get("/v1/agents/environments/:id/files", async (c) => {
    const spec = await c.env.catalog(c.get("tenant")).environment(c.req.param("id"));
    await c.env.session(c.get("tenant"), spec.sessionId);
    const driver = options.environments?.(c.env.env);
    if (!driver) throw new EnvironmentDriverUnavailable();
    return Response.json(
      await runPromise(driver.files(spec, parse(environmentFilePageSchema, c.req.query()))),
    );
  });
}
