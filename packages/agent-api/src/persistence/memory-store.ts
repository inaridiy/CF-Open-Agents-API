import { InvalidCursor } from "../errors.js";
import type { AgentSessionEvent, PageQuery } from "../protocol.js";
import { ApiError } from "../protocol.js";
import type { Kind } from "./kind.js";
import type { ListFilter, Page, RecordStore, Transactional } from "./record-store.js";
import { encodeRow } from "./row.js";

interface Row {
  seq: number;
  value: string;
}
const compareIds = (a: string, b: string): number => (a < b ? -1 : Number(a > b));
/** Read one JSON path the way `json_extract(value, '$.a.b')` does. */
function extract(value: unknown, path: string): unknown {
  let current: unknown = value;
  for (const segment of path.split(".")) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/**
 * A `RecordStore` over Maps for policy unit tests. Rows are stored serialized, so reads
 * hand out fresh values exactly as SQLite does, the row budget applies, and a throw inside
 * `transactionSync` rolls back. Ordering, pagination and the page byte budget are not
 * reproduced beyond a naive `list`; tests of those belong on `SqlStore`.
 */
export class MemoryStore implements RecordStore, Transactional {
  private records = new Map<string, Map<string, Row>>();
  private log: string[] = [];
  private sequence = 0;
  private table(kind: string): Map<string, Row> {
    let rows = this.records.get(kind);
    if (!rows) {
      rows = new Map();
      this.records.set(kind, rows);
    }
    return rows;
  }
  get<A>(kind: Kind<A>, id: string): A | undefined {
    const row = this.records.get(kind)?.get(id);
    return row ? (JSON.parse(row.value) as A) : undefined;
  }
  require<A>(kind: Kind<A>, id: string): A {
    const value = this.get(kind, id);
    if (!value) throw new ApiError(404, "not_found", `${kind} not found`);
    return value;
  }
  put<A>(kind: Kind<A>, id: string, value: NoInfer<A>, seq = this.sequence + 1): void {
    const encoded = encodeRow(value, kind, id);
    const rows = this.table(kind);
    const existing = rows.get(id);
    rows.set(id, { seq: existing?.seq ?? seq, value: encoded });
    this.sequence = Math.max(this.sequence, existing?.seq ?? seq);
  }
  remove(kind: Kind<unknown>, id: string): void {
    this.records.get(kind)?.delete(id);
  }
  clear(kind: Kind<unknown>): void {
    this.records.delete(kind);
  }
  list<A>(kind: Kind<A>, query: PageQuery, filter?: ListFilter): Page<A> {
    const selected = (value: unknown) =>
      filter?.field === undefined ||
      filter.value === undefined ||
      extract(value, filter.field) === filter.value;
    const unexpired = (value: unknown) => {
      if (filter?.expiresAfter === undefined) return true;
      const expires = extract(value, "resource.expires_at");
      return expires === null || expires === undefined || Number(expires) > filter.expiresAfter;
    };
    const direction = query.order === "asc" ? 1 : -1;
    const rows = [...(this.records.get(kind) ?? new Map<string, Row>())]
      .map(([id, row]) => ({ id, seq: row.seq, parsed: JSON.parse(row.value) as unknown }))
      .filter((row) => selected(row.parsed))
      .sort((a, b) => direction * (a.seq - b.seq || compareIds(a.id, b.id)));
    let start = 0;
    if (query.after) {
      const cursor = rows.findIndex((row) => row.id === query.after);
      if (cursor < 0) throw new InvalidCursor();
      start = cursor + 1;
    }
    const visible = rows.slice(start).filter((row) => unexpired(row.parsed));
    const page = visible.slice(0, query.limit);
    return {
      object: "list",
      data: page.map((row) => row.parsed as A),
      has_more: visible.length > query.limit,
      first_id: page[0]?.id ?? null,
      last_id: page.at(-1)?.id ?? null,
    };
  }
  append(event: AgentSessionEvent): number {
    this.log.push(encodeRow(event));
    return this.log.length;
  }
  events(after: number, limit = 100): { seq: number; event: AgentSessionEvent }[] {
    return this.log.slice(after, after + limit).map((value, index) => ({
      seq: after + index + 1,
      event: JSON.parse(value) as AgentSessionEvent,
    }));
  }
  lastEvent(): number {
    return this.log.length;
  }
  outputKey(itemId: string): string | undefined {
    for (const [id, row] of this.records.get("output") ?? [])
      if (extract(JSON.parse(row.value), "item.id") === itemId) return id;
    return undefined;
  }
  purge(): void {
    this.records = new Map();
    this.log = [];
  }
  /** Snapshot and restore on throw, which is the rollback `DurableObjectStorage` performs. */
  transactionSync<A>(closure: () => A): A {
    const records = new Map([...this.records].map(([kind, rows]) => [kind, new Map(rows)]));
    const log = [...this.log];
    const sequence = this.sequence;
    try {
      return closure();
    } catch (thrown) {
      this.records = records;
      this.log = log;
      this.sequence = sequence;
      throw thrown;
    }
  }
}
