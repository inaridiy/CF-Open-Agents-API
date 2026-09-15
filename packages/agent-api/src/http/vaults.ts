import { parse } from "../protocol.js";
import {
  credentialSchema,
  rotateCredentialSchema,
  vaultPageSchema,
  vaultSchema,
} from "../vaults.js";
import { jsonBody, type RouteApp } from "./context.js";

export function registerVaultRoutes<Env>(app: RouteApp<Env>) {
  app.post("/v1/vaults", async (c) =>
    Response.json(
      await c.env.catalog(c.get("tenant")).createVault(parse(vaultSchema, await jsonBody(c))),
    ),
  );
  const vaultQuery = (url: string) => {
    const query = new URL(url).searchParams;
    const statuses = query.getAll("status[]");
    const input = Object.fromEntries(query);
    delete input["status[]"];
    return parse(vaultPageSchema, {
      ...input,
      ...(statuses.length ? { status: statuses } : {}),
    });
  };
  app.get("/v1/vaults", async (c) =>
    Response.json(await c.env.catalog(c.get("tenant")).vaults(vaultQuery(c.req.url))),
  );
  app.get("/v1/vaults/:id", async (c) =>
    Response.json(await c.env.catalog(c.get("tenant")).vault(c.req.param("id"))),
  );
  app.delete("/v1/vaults/:id", async (c) =>
    Response.json(await c.env.catalog(c.get("tenant")).deleteVault(c.req.param("id"))),
  );
  app.post("/v1/vaults/:id/credentials", async (c) =>
    Response.json(
      await c.env
        .catalog(c.get("tenant"))
        .createCredential(c.req.param("id"), parse(credentialSchema, await jsonBody(c))),
    ),
  );
  app.get("/v1/vaults/:id/credentials", async (c) =>
    Response.json(
      await c.env.catalog(c.get("tenant")).credentials(c.req.param("id"), vaultQuery(c.req.url)),
    ),
  );
  app.get("/v1/vaults/:id/credentials/:credential", async (c) =>
    Response.json(
      await c.env.catalog(c.get("tenant")).credential(c.req.param("id"), c.req.param("credential")),
    ),
  );
  app.post("/v1/vaults/:id/credentials/:credential", async (c) =>
    Response.json(
      await c.env
        .catalog(c.get("tenant"))
        .rotateCredential(
          c.req.param("id"),
          c.req.param("credential"),
          parse(rotateCredentialSchema, await jsonBody(c)),
        ),
    ),
  );
  app.delete("/v1/vaults/:id/credentials/:credential", async (c) =>
    Response.json(
      await c.env
        .catalog(c.get("tenant"))
        .deleteCredential(c.req.param("id"), c.req.param("credential")),
    ),
  );
}
