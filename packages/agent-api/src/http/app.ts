import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";

import {
  BodyTooLarge,
  caughtFailure,
  InvalidJson,
  isPermanent,
  toApiError,
  Unauthorized,
} from "../errors.js";
import { INPUT_FILE_LIMIT } from "../files.js";
import { identifier } from "../protocol.js";
import type { ServiceOptions } from "../runtime.js";
import { SKILL_UPLOAD_LIMIT } from "../skills.js";
import { registerAgentRoutes } from "./agents.js";
import { registerCapabilityRoutes } from "./capabilities.js";
import type { RouteEnv } from "./context.js";
import { registerEnvironmentRoutes } from "./environments.js";
import { registerFileRoutes } from "./files.js";
import { registerSessionRoutes } from "./sessions.js";
import { registerSkillRoutes } from "./skills.js";
import { registerVaultRoutes } from "./vaults.js";

/** The one Hono app of a service; every handler reads its entrypoint from `c.env`. */
export function buildApplication<Env>(options: ServiceOptions<Env>): Hono<RouteEnv<Env>> {
  const app = new Hono<RouteEnv<Env>>();
  // Every response, including errors and streams, carries a request ID the SDK surfaces.
  app.use("*", async (c, next) => {
    await next();
    const id = identifier("req");
    try {
      c.res.headers.set("x-request-id", id);
    } catch {
      c.res = new Response(c.res.body, c.res);
      c.res.headers.set("x-request-id", id);
    }
  });
  app.use("*", async (c, next) => {
    // An RPC caller (`fetchAs`) resolved the tenant itself; HTTP callers authenticate.
    const tenant = c.env.tenant ?? (await options.authenticate(c.req.raw, c.env.env));
    if (!tenant) throw new Unauthorized();
    c.set("tenant", tenant);
    await next();
  });
  // Authenticated callers only: an anonymous request never buffers an upload.
  app.use("*", async (c: Context<RouteEnv<Env>, "*", {}>, next) =>
    bodyLimit({
      maxSize: requestBodyLimit(c.req.path),
      onError: () => {
        throw new BodyTooLarge();
      },
    })(c, next),
  );
  app.onError((error) => {
    const failure = error instanceof SyntaxError ? new InvalidJson() : caughtFailure(error);
    const known = failure && toApiError(failure);
    if (!known || known.status === 500)
      console.error("Agent API request failed", { message: error.message });
    const status = known ? known.status : 500;
    const response = Response.json(
      {
        error: {
          message: known ? known.message : "Internal server error",
          type: errorType(status),
          code: known ? known.code : "internal_error",
          param: null,
        },
      },
      { status },
    );
    // The SDK retries 409 by default; these conflicts never resolve by retrying.
    if (failure && isPermanent(failure)) response.headers.set("x-should-retry", "false");
    return response;
  });
  registerCapabilityRoutes(app, options);
  registerSkillRoutes(app, options);
  registerFileRoutes(app, options);
  registerSessionRoutes(app, options);
  registerAgentRoutes(app);
  registerEnvironmentRoutes(app, options);
  registerVaultRoutes(app);
  app.notFound(() =>
    Response.json(
      {
        error: {
          code: "unsupported_endpoint",
          type: "invalid_request_error",
          message: "Endpoint is not part of this deployment's compatibility profile",
          param: null,
        },
      },
      { status: 404 },
    ),
  );
  return app;
}
/** Uploads get their own budget; every other body stays under 16 MiB. */
function requestBodyLimit(path: string): number {
  if (path === "/v1/files") return INPUT_FILE_LIMIT + 64 * 1024;
  if (path.startsWith("/v1/skills")) return SKILL_UPLOAD_LIMIT + 128 * 1024;
  return 16 * 1024 * 1024;
}
/** OpenAI's error envelope categorizes by status; the SDK selects error classes by status too. */
function errorType(status: number): string {
  if (status === 401) return "authentication_error";
  if (status === 403) return "permission_error";
  if (status === 429) return "rate_limit_error";
  if (status >= 500) return "server_error";
  return "invalid_request_error";
}
