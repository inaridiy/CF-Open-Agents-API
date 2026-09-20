import type { Effect } from "effect";
import type { Hono } from "hono";

import type { CatalogObject } from "../catalog.js";
import {
  type CapabilityUnsupported,
  type DelegateUnavailable,
  type ModelNotRegistered,
  ObjectStorageUnavailable,
  type ReservedToolName,
} from "../errors.js";
import type { AgentRegistration, RuntimeDriver, ServiceOptions } from "../runtime.js";
import type { AgentRPC } from "../service.js";
import type { SessionObject } from "../session.js";

/** The per-request view route handlers use; it keeps private helpers off the RPC surface. */
export interface WorkerAccess<Env> extends AgentRPC {
  env: Env;
  /** Set by `fetchAs`: the tenant a trusted RPC caller resolved, so the authenticator is skipped. */
  tenant?: string;
  catalog(tenant: string): DurableObjectStub<CatalogObject>;
  session(tenant: string, id: string): Promise<DurableObjectStub<SessionObject>>;
  validateModel(
    model: string,
    agent: {
      tools?: readonly { type: string; defer_loading?: boolean; enabled?: boolean }[] | null;
      multi_agent?: { enabled: boolean } | null;
    },
    sandbox: boolean,
  ): Effect.Effect<
    { registration: AgentRegistration; driver: RuntimeDriver },
    ModelNotRegistered | CapabilityUnsupported | ReservedToolName | DelegateUnavailable
  >;
}
export type RouteEnv<Env> = { Bindings: WorkerAccess<Env>; Variables: { tenant: string } };
/** The one Hono app of a service; every route module registers on it in order. */
export type RouteApp<Env> = Hono<RouteEnv<Env>>;
export type RouteContext = { req: { raw: Request; text(): Promise<string> } };

/**
 * The official SDK sends no body when every parameter of an update or create call is
 * omitted; an absent or empty body means "no changes", not malformed JSON.
 */
export async function jsonBody(c: RouteContext): Promise<unknown> {
  if (!c.req.raw.body) return {};
  const text = await c.req.text();
  return text.trim() ? JSON.parse(text) : {};
}
/** The deployment's object storage, or the 503 a route without one answers with. */
export function objects<Env>(options: ServiceOptions<Env>, worker: WorkerAccess<Env>): R2Bucket {
  const bucket = options.objects?.(worker.env);
  if (!bucket) throw new ObjectStorageUnavailable();
  return bucket;
}
