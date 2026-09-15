import { COMPATIBILITY } from "../protocol.js";
import type { ServiceOptions } from "../runtime.js";
import type { RouteApp } from "./context.js";

export function registerCapabilityRoutes<Env>(app: RouteApp<Env>, options: ServiceOptions<Env>) {
  app.get("/cf/v1/capabilities", (c) =>
    Response.json({
      ...COMPATIBILITY,
      agents: options.agents,
      harnesses: Object.fromEntries(
        Object.values(options.harnesses(c.env.env)).map((driver) => [
          driver.name,
          { revision: driver.revision, ...driver.capabilities },
        ]),
      ),
      extensions: ["event_replay"],
      hosted_environment_provider: "cloudflare",
    }),
  );
}
