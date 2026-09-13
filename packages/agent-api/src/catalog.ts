import { DurableObject } from "cloudflare:workers";
import type { Agent, PageQuery } from "./protocol.js";
import { ApiError, canonicalJSON, identifier, rpcFailure } from "./protocol.js";
import type { SessionRecord } from "./session.js";
import { SqlStore } from "./storage.js";

export interface Reservation {
  id: string;
  record: SessionRecord;
  ready: boolean;
  fingerprint: string;
}

/** One catalog per authenticated tenant, never one global object. */
export class CatalogObject extends DurableObject {
  readonly db = new SqlStore(this.ctx.storage);
  reservation(key: string, fingerprint: string): string {
    try {
      const previous = this.db.get<Reservation>("reservation", key);
      if (previous && previous.fingerprint !== fingerprint)
        throw new ApiError(
          409,
          "idempotency_conflict",
          "Key was used with different session parameters",
        );
      return JSON.stringify({ ok: true, value: previous ?? null });
    } catch (error) {
      return JSON.stringify(rpcFailure(error));
    }
  }
  reserve(key: string, fingerprint: string, record: SessionRecord): string {
    try {
      const value = this.db.transaction(() => {
        const previous = this.db.get<Reservation>("reservation", key);
        if (previous) {
          if (previous.fingerprint !== fingerprint)
            throw new ApiError(
              409,
              "idempotency_conflict",
              "Key was used with different session parameters",
            );
          return previous;
        }
        const reservation = { id: record.session.id, record, ready: false, fingerprint };
        this.db.put("reservation", key, reservation);
        return reservation;
      });
      return JSON.stringify({ ok: true, value });
    } catch (error) {
      return JSON.stringify(rpcFailure(error));
    }
  }
  commit(key: string): void {
    this.db.transaction(() => {
      const reservation = this.db.require<Reservation>("reservation", key);
      if (reservation.ready) return;
      this.db.put("reservation", key, { ...reservation, ready: true });
      this.db.put("session", reservation.id, {
        id: reservation.id,
        agent_id: reservation.record.session.agent.id,
      });
    });
  }
  owns(id: string): boolean {
    return this.db.get("session", id) !== undefined;
  }
  sessions(query: PageQuery) {
    return this.db.list<{ id: string; agent_id: string }>("session", query);
  }
  deleteSession(id: string): void {
    this.db.remove("session", id);
  }
  agent(id: string): Agent {
    return this.db.require<Agent>("agent", id);
  }
  agents(query: PageQuery) {
    return this.db.list<Agent>("agent", query);
  }
  saveAgent(agent: Agent, key: string): Agent {
    return this.db.transaction(() => {
      const fingerprint = canonicalJSON({
        ...agent,
        id: undefined,
        created_at: undefined,
        updated_at: undefined,
      });
      const previous = this.db.get<{ fingerprint: string; id: string }>("agent_key", key);
      if (previous) {
        if (previous.fingerprint !== fingerprint)
          throw new ApiError(
            409,
            "idempotency_conflict",
            "Key was used with different agent parameters",
          );
        return this.agent(previous.id);
      }
      this.db.put("agent", agent.id, agent);
      this.db.put("agent_key", key, { fingerprint, id: agent.id });
      return agent;
    });
  }
  deleteAgent(id: string) {
    this.agent(id);
    this.db.remove("agent", id);
    return { id, object: "agent.deleted" as const, deleted: true };
  }
}

export function agentResource(input: {
  model: string;
  instructions?: string | null;
  name?: string | null;
  metadata?: Record<string, string> | null;
  tools?: Agent["tools"] | null;
}): Agent {
  const now = Math.floor(Date.now() / 1_000);
  return {
    id: identifier("agent"),
    object: "agent",
    created_at: now,
    updated_at: now,
    name: input.name ?? null,
    model: input.model,
    instructions: input.instructions ?? null,
    metadata: input.metadata ?? {},
    tools: input.tools ?? [],
    multi_agent: { enabled: false, max_concurrent_subagents: null },
    reasoning: { effort: null, summary: null },
    service_tier: "auto",
    text: { format: { type: "text" }, verbosity: "medium" },
  };
}
