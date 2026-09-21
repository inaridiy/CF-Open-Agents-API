import type { Effect } from "effect";

import type { AgentSessionEvent, PageQuery } from "../protocol.js";
import type { Kind } from "./kind.js";

export interface Page<A> {
  object: "list";
  data: A[];
  has_more: boolean;
  first_id: string | null;
  last_id: string | null;
}
type ListField =
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

/** The page size every internal walk reads; a public listing sets its own limit. */
const WALK_PAGE = 100;
/**
 * Every page of `kind` under `filter`, in ascending id order. The cursor walk lives here
 * once: a caller that folds a page at a time (a transcript, a batch of uploads) takes
 * `eachPage`, and one that only needs the records takes `eachRecord`.
 */
export function* eachPage<A>(
  store: Pick<RecordStore, "list">,
  kind: Kind<A>,
  filter?: ListFilter,
): Generator<A[]> {
  let after: string | undefined;
  do {
    const page = store.list(kind, { order: "asc", limit: WALK_PAGE, after }, filter);
    yield page.data;
    after = page.has_more ? (page.last_id ?? undefined) : undefined;
  } while (after);
}
/** The same walk, record by record. */
export function* eachRecord<A>(
  store: Pick<RecordStore, "list">,
  kind: Kind<A>,
  filter?: ListFilter,
): Generator<A> {
  for (const page of eachPage(store, kind, filter)) yield* page;
}
/** A stored page projected through `f`; the cursor fields are the store's, never rebuilt. */
export const mapPage = <A, B>(page: Page<A>, f: (row: A) => B): Page<B> => ({
  ...page,
  data: page.data.map(f),
});
/** The common projection: rows stored as `{ resource }` envelopes answer as the resource. */
export const resourcePage = <A>(page: Page<{ resource: A }>): Page<A> =>
  mapPage(page, ({ resource }) => resource);
/** No rows at all, for a filter the store cannot express because nothing is stored. */
export const emptyPage = <A>(): Page<A> => ({
  object: "list",
  data: [],
  has_more: false,
  first_id: null,
  last_id: null,
});

/** A synchronous result: returning a Promise or an Effect from the seam is a type error. */
export type Sync<A> = A &
  (A extends PromiseLike<unknown> | Effect.Effect<unknown, unknown, unknown> ? never : unknown);

/**
 * Whatever runs a synchronous closure atomically: DO storage, or a fake with rollback.
 * One name for it, `transaction`, which the lint plugin knows as a transaction callback.
 */
export interface Transactional {
  transaction<A>(closure: () => Sync<A>): A;
}
