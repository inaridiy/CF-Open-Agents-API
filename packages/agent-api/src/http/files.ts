import { z } from "zod";

import { runPromise } from "../effect.js";
import { StoredObjectMissing } from "../errors.js";
import { uploadInputFile } from "../files.js";
import { pageSchema, parse } from "../protocol.js";
import type { ServiceOptions } from "../runtime.js";
import { objects, type RouteApp } from "./context.js";

export function registerFileRoutes<Env>(app: RouteApp<Env>, options: ServiceOptions<Env>) {
  app.post("/v1/files", async (c) => {
    // lint: entrypoint
    const record = await runPromise(
      uploadInputFile(objects(options, c.env), await c.req.formData()),
    );
    await c.env.catalog(c.get("tenant")).saveFile(record);
    return Response.json(record.resource);
  });
  app.get("/v1/files", async (c) => {
    const { purpose, ...page } = parse(
      pageSchema.extend({ purpose: z.string().max(64).optional() }),
      c.req.query(),
    );
    return Response.json(await c.env.catalog(c.get("tenant")).files(page, purpose));
  });
  app.get("/v1/files/:id", async (c) =>
    Response.json((await c.env.catalog(c.get("tenant")).file(c.req.param("id"))).resource),
  );
  app.get("/v1/files/:id/content", async (c) => {
    const record = await c.env.catalog(c.get("tenant")).file(c.req.param("id"));
    const object = await objects(options, c.env).get(record.key);
    if (!object) throw new StoredObjectMissing({ object: "file_content" });
    return new Response(object.body, {
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(object.size),
        "content-disposition": "attachment",
      },
    });
  });
  app.delete("/v1/files/:id", async (c) => {
    const catalog = c.env.catalog(c.get("tenant"));
    const record = await catalog.file(c.req.param("id"));
    await objects(options, c.env).delete(record.key);
    await catalog.deleteFile(record.resource.id);
    return Response.json({ id: record.resource.id, object: "file", deleted: true });
  });
}
