import type { AgentSessionEvent, PageQuery } from "../protocol.js";
import type { Kind } from "./kind.js";

export interface Page<A> {
  object: "list";
  data: A[];
  has_more: boolean;
  first_id: string | null;
  last_id: string | null;
}
export type ListField =
  | "agent_id"
  | "environment_id"
  | "turn_id"
  | "item.turn_id"
  | "resource.purpose"
  | "status";
export interface ListFilter {
  field?: ListField;
  value?: string;
  expiresAfter?: number;
}

/**
 * The inside of the persistence seam: synchronous, typed by record kind, and free of
 * Effect. `SqlStore` is the durable implementation; `MemoryStore` stands in for policy
 * unit tests and must never be used where ordering, pagination or size limits are the
 * subject, because those are SQLite's semantics.
 */
export interface RecordStore {
  get<A>(kind: Kind<A>, id: string): A | undefined;
  /** Throws `RecordNotFound` naming the kind. */
  require<A>(kind: Kind<A>, id: string): A;
  /** Throws `RecordTooLarge` past the row budget. */
  put<A>(kind: Kind<A>, id: string, value: NoInfer<A>, seq?: number): void;
  remove(kind: Kind<unknown>, id: string): void;
  clear(kind: Kind<unknown>): void;
  /** Throws `InvalidCursor` when `after` names no row of this kind (under the same filter). */
  list<A>(kind: Kind<A>, query: PageQuery, filter?: ListFilter): Page<A>;
  append(event: AgentSessionEvent): number;
  events(after: number, limit?: number): { seq: number; event: AgentSessionEvent }[];
  lastEvent(): number;
  /** Resolve the native position key when a streamed public item is finalized. */
  outputKey(itemId: string): string | undefined;
  /** Remove every record and event; the store stays usable. */
  purge(): void;
}

/** Whatever runs a synchronous closure atomically: DO storage, or a fake with rollback. */
export interface Transactional {
  transactionSync<A>(closure: () => A): A;
}
