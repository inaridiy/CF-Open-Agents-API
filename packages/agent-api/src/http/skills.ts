import { SkillInvalid, StoredObjectMissing } from "../errors.js";
import { identifier, pageSchema, parse } from "../protocol.js";
import type { ServiceOptions } from "../runtime.js";
import { readSkillUpload } from "../skills.js";
import { jsonBody, objects, type RouteApp, type WorkerAccess } from "./context.js";

export function registerSkillRoutes<Env>(app: RouteApp<Env>, options: ServiceOptions<Env>) {
  const uploadSkill = async (
    worker: WorkerAccess<Env>,
    request: Request,
    tenant: string,
    skillId?: string,
  ) => {
    const catalog = worker.catalog(tenant);
    const bucket = objects(options, worker);
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      throw new SkillInvalid({ reason: "Provide multipart skill files or a ZIP archive" });
    }
    const { bundle, makeDefault, ...metadata } = await readSkillUpload(form);
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bundle)), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    const operation = {
      hash,
      skillId,
      makeDefault,
      operationId: request.headers.get("Idempotency-Key") ?? identifier("key"),
    };
    const { key, resource } = await catalog.prepareSkill(operation);
    if (resource) return resource;
    await bucket.put(key, bundle, { httpMetadata: { contentType: "application/zip" } });
    return catalog.addSkill({
      ...metadata,
      key,
      ...operation,
    });
  };
  const skillContent = async (
    worker: WorkerAccess<Env>,
    tenant: string,
    id: string,
    selector?: string,
  ) => {
    const version = await worker.catalog(tenant).skillVersion(id, selector);
    const object = await objects(options, worker).get(version.key);
    if (!object) throw new StoredObjectMissing({ object: "skill_content" });
    return new Response(object.body, {
      headers: {
        "content-type": "application/zip",
        "content-length": String(object.size),
        "content-disposition": "attachment",
      },
    });
  };
  app.post("/v1/skills", async (c) =>
    Response.json(await uploadSkill(c.env, c.req.raw, c.get("tenant"))),
  );
  app.get("/v1/skills", async (c) =>
    Response.json(await c.env.catalog(c.get("tenant")).skills(parse(pageSchema, c.req.query()))),
  );
  app.get("/v1/skills/:id", async (c) =>
    Response.json(await c.env.catalog(c.get("tenant")).skill(c.req.param("id"))),
  );
  app.post("/v1/skills/:id", async (c) =>
    Response.json(
      await c.env.catalog(c.get("tenant")).updateSkill(c.req.param("id"), await jsonBody(c)),
    ),
  );
  app.delete("/v1/skills/:id", async (c) =>
    Response.json(await c.env.catalog(c.get("tenant")).deleteSkill(c.req.param("id"))),
  );
  app.get("/v1/skills/:id/content", (c) => skillContent(c.env, c.get("tenant"), c.req.param("id")));
  app.post("/v1/skills/:id/versions", async (c) =>
    Response.json(await uploadSkill(c.env, c.req.raw, c.get("tenant"), c.req.param("id"))),
  );
  app.get("/v1/skills/:id/versions", async (c) =>
    Response.json(
      await c.env
        .catalog(c.get("tenant"))
        .skillVersions(c.req.param("id"), parse(pageSchema, c.req.query())),
    ),
  );
  app.get("/v1/skills/:id/versions/:version", async (c) =>
    Response.json(
      (await c.env.catalog(c.get("tenant")).skillVersion(c.req.param("id"), c.req.param("version")))
        .resource,
    ),
  );
  app.delete("/v1/skills/:id/versions/:version", async (c) =>
    Response.json(
      await c.env
        .catalog(c.get("tenant"))
        .deleteSkillVersion(c.req.param("id"), c.req.param("version")),
    ),
  );
  app.get("/v1/skills/:id/versions/:version/content", (c) =>
    skillContent(c.env, c.get("tenant"), c.req.param("id"), c.req.param("version")),
  );
}
