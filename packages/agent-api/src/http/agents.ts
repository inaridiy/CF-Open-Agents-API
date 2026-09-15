import { agentResource } from "../catalog.js";
import { runPromise } from "../effect.js";
import { identifier, pageSchema, parse, savedAgentSchema } from "../protocol.js";
import { jsonBody, type RouteApp } from "./context.js";

export function registerAgentRoutes<Env>(app: RouteApp<Env>) {
  app.post("/v1/agents", async (c) => {
    const input = parse(savedAgentSchema, await jsonBody(c));
    await runPromise(c.env.validateModel(input.model, input, false));
    return Response.json(
      await c.env
        .catalog(c.get("tenant"))
        .saveAgent(agentResource(input), c.req.header("Idempotency-Key") ?? identifier("key")),
    );
  });
  app.get("/v1/agents", async (c) =>
    Response.json(await c.env.catalog(c.get("tenant")).agents(parse(pageSchema, c.req.query()))),
  );
  app.get("/v1/agents/:id", async (c) =>
    Response.json(await c.env.catalog(c.get("tenant")).agent(c.req.param("id"))),
  );
  app.post("/v1/agents/:id", async (c) => {
    const input = parse(savedAgentSchema.partial(), await jsonBody(c));
    const catalog = c.env.catalog(c.get("tenant"));
    const previous = await catalog.agent(c.req.param("id"));
    await runPromise(
      c.env.validateModel(
        input.model ?? previous.model,
        {
          tools: input.tools === undefined ? previous.tools : input.tools,
          multi_agent:
            input.multi_agent === undefined
              ? { enabled: previous.multi_agent.enabled }
              : input.multi_agent,
        },
        false,
      ),
    );
    return Response.json(await catalog.updateAgent(c.req.param("id"), input));
  });
  app.delete("/v1/agents/:id", async (c) =>
    Response.json(await c.env.catalog(c.get("tenant")).deleteAgent(c.req.param("id"))),
  );
}
