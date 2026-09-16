import { z } from "zod";

import { StoredObjectMissing } from "../errors.js";
import {
  createSessionSchema,
  eventsSchema,
  forkSessionSchema,
  metadataSchema,
  pageSchema,
  parse,
  sessionPageSchema,
} from "../protocol.js";
import type { ServiceOptions } from "../runtime.js";
import { jsonBody, type RouteApp } from "./context.js";

export function registerSessionRoutes<Env>(app: RouteApp<Env>, options: ServiceOptions<Env>) {
  app.post("/v1/agents/sessions", async (c) => {
    const input = parse(createSessionSchema, await jsonBody(c));
    const session = await c.env.createSession(
      c.get("tenant"),
      input,
      c.req.header("Idempotency-Key"),
    );
    // A creation stream covers the initial turn, then ends; live streams use /events.
    return input.stream
      ? await (await c.env.session(c.get("tenant"), session.id)).stream(0, { initial: true })
      : Response.json(session);
  });
  app.get("/v1/agents/sessions", async (c) =>
    Response.json(
      await c.env.listSessions(c.get("tenant"), parse(sessionPageSchema, c.req.query())),
    ),
  );
  app.get("/v1/agents/sessions/:id", async (c) =>
    Response.json(await c.env.retrieveSession(c.get("tenant"), c.req.param("id"))),
  );
  app.post("/v1/agents/sessions/:id", async (c) => {
    const input = parse(z.strictObject({ metadata: metadataSchema }), await jsonBody(c));
    const stub = await c.env.session(c.get("tenant"), c.req.param("id"));
    return Response.json(
      input.metadata === undefined
        ? await stub.retrieve()
        : await stub.update(input.metadata ?? {}),
    );
  });
  app.delete("/v1/agents/sessions/:id", async (c) =>
    Response.json(await c.env.deleteSession(c.get("tenant"), c.req.param("id"))),
  );
  app.post("/v1/agents/sessions/:id/events", async (c) => {
    const input = parse(eventsSchema, await jsonBody(c));
    await c.env.submitEvents(
      c.get("tenant"),
      c.req.param("id"),
      input.events,
      c.req.header("Idempotency-Key"),
    );
    return c.body(null, 204);
  });
  app.get(
    "/v1/agents/sessions/:id/events",
    async (c) => await (await c.env.session(c.get("tenant"), c.req.param("id"))).stream(),
  );
  app.post("/cf/v1/sessions/:id/fork", async (c) => {
    // A fork needs no body; an empty or absent one means "same configuration".
    const body = await c.req.text();
    return Response.json(
      await c.env.forkSession(
        c.get("tenant"),
        c.req.param("id"),
        parse(forkSessionSchema, body.trim() ? JSON.parse(body) : {}),
        c.req.header("Idempotency-Key"),
      ),
    );
  });
  app.get("/cf/v1/sessions/:id/events", async (c) => {
    const after = parse(z.coerce.number().int().min(0), c.req.query("after") ?? "0");
    return Response.json(
      await (await c.env.session(c.get("tenant"), c.req.param("id"))).replay(after),
    );
  });
  app.get("/v1/agents/sessions/:id/items", async (c) =>
    Response.json(
      await c.env.listItems(c.get("tenant"), c.req.param("id"), parse(pageSchema, c.req.query())),
    ),
  );
  app.get("/v1/agents/sessions/:id/turns", async (c) =>
    Response.json(
      await c.env.listTurns(c.get("tenant"), c.req.param("id"), parse(pageSchema, c.req.query())),
    ),
  );
  app.get("/v1/agents/sessions/:id/turns/:turn", async (c) =>
    Response.json(
      await c.env.retrieveTurn(c.get("tenant"), c.req.param("id"), c.req.param("turn")),
    ),
  );
  app.get("/v1/agents/sessions/:id/subagents", async (c) =>
    Response.json(
      await (
        await c.env.session(c.get("tenant"), c.req.param("id"))
      ).subagents(parse(pageSchema, c.req.query())),
    ),
  );
  app.get("/v1/agents/sessions/:id/subagents/:subagent", async (c) =>
    Response.json(
      await (
        await c.env.session(c.get("tenant"), c.req.param("id"))
      ).subagent(c.req.param("subagent")),
    ),
  );
  app.get("/v1/agents/sessions/:id/subagents/:subagent/items", async (c) =>
    Response.json(
      await (
        await c.env.session(c.get("tenant"), c.req.param("id"))
      ).subagentItems(c.req.param("subagent"), parse(pageSchema, c.req.query())),
    ),
  );
  app.get("/v1/agents/sessions/:id/subagents/:subagent/turns", async (c) =>
    Response.json(
      await (
        await c.env.session(c.get("tenant"), c.req.param("id"))
      ).subagentTurns(c.req.param("subagent"), parse(pageSchema, c.req.query())),
    ),
  );
  app.get("/v1/agents/sessions/:id/subagents/:subagent/turns/:turn", async (c) =>
    Response.json(
      await (
        await c.env.session(c.get("tenant"), c.req.param("id"))
      ).subagentTurn(c.req.param("subagent"), c.req.param("turn")),
    ),
  );
  app.get("/v1/agents/sessions/:id/subagents/:subagent/turns/:turn/items", async (c) =>
    Response.json(
      await (
        await c.env.session(c.get("tenant"), c.req.param("id"))
      ).subagentItems(
        c.req.param("subagent"),
        parse(pageSchema, c.req.query()),
        c.req.param("turn"),
      ),
    ),
  );
  app.get("/v1/agents/sessions/:id/artifacts", async (c) => {
    const query = parse(
      pageSchema.extend({ environment_id: z.string().nullable().optional() }),
      c.req.query(),
    );
    const { environment_id, ...page } = query;
    return Response.json(
      await (
        await c.env.session(c.get("tenant"), c.req.param("id"))
      ).artifacts(page, environment_id ?? undefined),
    );
  });
  app.get("/v1/agents/sessions/:id/artifacts/:artifact", async (c) => {
    const { key: _key, ...resource } = await (
      await c.env.session(c.get("tenant"), c.req.param("id"))
    ).artifact(c.req.param("artifact"));
    return Response.json(resource);
  });
  app.get("/v1/agents/sessions/:id/artifacts/:artifact/content", async (c) => {
    const artifact = await (
      await c.env.session(c.get("tenant"), c.req.param("id"))
    ).artifact(c.req.param("artifact"));
    const object = await options.objects?.(c.env.env).get(artifact.key);
    if (!object) throw new StoredObjectMissing({ object: "artifact_content" });
    return new Response(object.body, {
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(object.size),
        "content-disposition": "attachment",
        etag: object.httpEtag,
      },
    });
  });
  app.delete("/v1/agents/sessions/:id/artifacts/:artifact", async (c) => {
    const stub = await c.env.session(c.get("tenant"), c.req.param("id"));
    const artifact = await stub.artifact(c.req.param("artifact"));
    await options.objects?.(c.env.env).delete(artifact.key);
    await stub.deleteArtifact(artifact.id);
    return Response.json({
      id: artifact.id,
      object: "agent.session.artifact.deleted",
      deleted: true,
    });
  });
}
