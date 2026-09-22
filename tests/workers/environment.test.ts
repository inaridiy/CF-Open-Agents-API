/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { reset, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import OpenAI from "openai";
import type { AgentSessionEvent } from "openai/resources/beta/agents/agents";
import { afterEach, expect, it } from "vitest";

import {
  type ContainerBindings,
  missingBackupCredentials,
} from "../../packages/agent-api/src/containers.js";
import { SessionKinds } from "../../packages/agent-api/src/persistence/session-kinds.js";
import type * as WorkerModule from "./worker.js";
import type { SessionDO, TestEnv } from "./worker.js";

declare global {
  namespace Cloudflare {
    interface Env extends TestEnv {}
    interface GlobalProps {
      mainModule: typeof WorkerModule;
    }
  }
}

const tenant = "environment";
const api = new OpenAI({
  apiKey: tenant,
  baseURL: "https://api.test/v1",
  maxRetries: 0,
  fetch: (input, init) => exports.default.fetch(new Request(input, init)),
});
const stub = (id: string) => env.SESSIONS.getByName(JSON.stringify([tenant, id]));
const replay = async (id: string) =>
  await (
    await exports.default.fetch(
      new Request(`https://api.test/cf/v1/sessions/${id}/events?after=0`, {
        headers: { authorization: `Bearer ${tenant}` },
      }),
    )
  ).json<{ seq: number; event: AgentSessionEvent }[]>();
const resetActivity = (id: string) =>
  runInDurableObject<SessionDO, void>(stub(id), (instance) => {
    const record = instance.db.require(SessionKinds.state, "session");
    instance.db.put(SessionKinds.state, "session", {
      ...record,
      session: { ...record.session, last_active_at: 0 },
    });
  });
/**
 * Zero `last_active_at` and run the reconciler in one Durable Object event, so the alarm
 * a command armed cannot settle the turn between the reset and the tick.
 */
const resetActivityAndTick = (id: string) =>
  runInDurableObject<SessionDO, void>(stub(id), async (instance) => {
    const record = instance.db.require(SessionKinds.state, "session");
    instance.db.put(SessionKinds.state, "session", {
      ...record,
      session: { ...record.session, last_active_at: 0 },
    });
    await instance.alarm();
  });
afterEach(() => reset());

it("last_active_at moves on every accepted input and when a turn settles", async () => {
  const session = await api.beta.agents.sessions.create({
    agent: { model: "test" },
    environment: { type: "none" },
    input: "hold",
  });
  expect(session.last_active_at).toBeGreaterThanOrEqual(session.created_at);
  await runDurableObjectAlarm(stub(session.id));
  await resetActivity(session.id);
  await api.beta.agents.sessions.events.create(session.id, {
    events: [{ type: "agent.session.input.cancel" }],
  });
  expect((await api.beta.agents.sessions.retrieve(session.id)).last_active_at).toBeGreaterThan(0);
  await resetActivityAndTick(session.id);
  const settled = await api.beta.agents.sessions.retrieve(session.id);
  expect(settled.status).toBe("idle");
  expect(settled.last_active_at).toBeGreaterThan(0);
});

it("reports a lost sandbox as environment.disconnected and a restored one as connected again", async () => {
  const session = await api.beta.agents.sessions.create({
    agent: { model: "test-hosted" },
    environment: { type: "openai_hosted" },
  });
  if (session.environment.type !== "openai_hosted")
    throw new Error("Expected a hosted environment");
  const environmentId = session.environment.id;
  const statuses = async () =>
    (await replay(session.id))
      .map(({ event }) => event.type)
      .filter((type) => type.startsWith("agent.session.environment."));
  expect(await statuses()).toEqual([
    "agent.session.environment.pending",
    "agent.session.environment.connected",
  ]);
  expect((await api.beta.agents.environments.retrieve(environmentId)).status).toBe("connected");
  expect(await statuses()).toHaveLength(2);
  await env.ASSETS.put(`environment-status/${session.id}`, "disconnected");
  expect((await api.beta.agents.environments.retrieve(environmentId)).status).toBe("disconnected");
  expect((await api.beta.agents.environments.retrieve(environmentId)).status).toBe("disconnected");
  expect(await statuses()).toEqual([
    "agent.session.environment.pending",
    "agent.session.environment.connected",
    "agent.session.environment.disconnected",
  ]);
  const disconnected = (await replay(session.id)).map(({ event }) => event).at(-1);
  expect(disconnected).toMatchObject({
    type: "agent.session.environment.disconnected",
    session_id: session.id,
    environment: { id: environmentId, status: "disconnected", error: null },
  });
  await env.ASSETS.put(`environment-status/${session.id}`, "connected");
  expect((await api.beta.agents.environments.retrieve(environmentId)).status).toBe("connected");
  expect((await statuses()).at(-1)).toBe("agent.session.environment.connected");
  // The session itself stays usable throughout.
  expect((await api.beta.agents.sessions.retrieve(session.id)).status).toBe("idle");
});

it("answers creation with 503 before reserving an environment the deployment cannot host", async () => {
  await env.ASSETS.put("environment-preflight", "blocked");
  const refused: unknown = await api.beta.agents.sessions
    .create({ agent: { model: "test-hosted" }, environment: { type: "openai_hosted" } })
    .catch((error: unknown) => error);
  expect(refused).toBeInstanceOf(OpenAI.APIError);
  const apiError = refused as InstanceType<typeof OpenAI.APIError>;
  expect(apiError.status).toBe(503);
  expect(apiError.code).toBe("environment_unavailable");
  expect(apiError.message).toContain("R2_ACCESS_KEY_ID");
  // Nothing was committed: the tenant lists no session, and the fixed deployment starts clean.
  expect((await api.beta.agents.sessions.list()).data).toEqual([]);
  await env.ASSETS.delete("environment-preflight");
  const session = await api.beta.agents.sessions.create({
    agent: { model: "test-hosted" },
    environment: { type: "openai_hosted" },
  });
  expect(session.status).toBe("idle");
  expect(
    (await replay(session.id))
      .map(({ event }) => event.type)
      .filter((type) => type.startsWith("agent.session.environment.")),
  ).toEqual(["agent.session.environment.pending", "agent.session.environment.connected"]);
});

it("names every backup secret the Sandbox SDK reads, unless backups are local", () => {
  expect(missingBackupCredentials({ LOCAL_BACKUPS: "true" } as ContainerBindings)).toEqual([]);
  expect(
    missingBackupCredentials({ BACKUP_BUCKET_NAME: "workspaces" } as ContainerBindings),
  ).toEqual(["CLOUDFLARE_R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"]);
  expect(
    missingBackupCredentials({
      CLOUDFLARE_ACCOUNT_ID: "a",
      R2_ACCESS_KEY_ID: "k",
      R2_SECRET_ACCESS_KEY: "s",
      BACKUP_BUCKET_NAME: "workspaces",
    } as ContainerBindings),
  ).toEqual([]);
});
