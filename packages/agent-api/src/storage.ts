import type { Effect } from "effect";
import {
  type Compilable,
  DummyDriver,
  type Generated,
  Kysely,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
  sql,
} from "kysely";

import type { PageQuery } from "./protocol.js";
import { ApiError } from "./protocol.js";

// Leave space for SQLite's row metadata below the platform's 2 MB row limit.
const MAX_ROW_BYTES = 1_900_000;
// A page stops growing past this many serialized characters, so a response stays
// far below the isolate's memory limit even when every record is at the row limit.
const MAX_PAGE_CHARS = 4 * 1024 * 1024;
function encodeRow(value: unknown, ...keys: string[]): string {
  const serialized = JSON.stringify(value);
  const encoder = new TextEncoder();
  const size =
    encoder.encode(serialized).byteLength +
    keys.reduce((total, key) => total + encoder.encode(key).byteLength, 0);
  if (size > MAX_ROW_BYTES)
    throw new ApiError(
      413,
      "storage_record_too_large",
      "Serialized record exceeds 1,900,000 bytes",
    );
  return serialized;
}

interface Database {
  records: { kind: string; id: string; seq: number; value: string };
  events: { seq: Generated<number>; value: string };
}

/**
 * Kysely builds and types every query. Execution stays synchronous so a complete
 * state transition can use DO transactionSync, including rollback on a guard.
 * Kysely's async transaction() cannot express that platform contract.
 */
export class SqlStore {
  readonly queries: Kysely<Database>;
  constructor(readonly storage: DurableObjectStorage) {
    this.queries = new Kysely<Database>({
      dialect: {
        createAdapter: () => new SqliteAdapter(),
        createDriver: () => new DummyDriver(),
        createIntrospector: (db) => new SqliteIntrospector(db),
        createQueryCompiler: () => new SqliteQueryCompiler(),
      },
    });
    this.execute(
      this.queries.schema
        .createTable("records")
        .ifNotExists()
        .addColumn("kind", "text", (c) => c.notNull())
        .addColumn("id", "text", (c) => c.notNull())
        .addColumn("seq", "integer", (c) => c.notNull())
        .addColumn("value", "text", (c) => c.notNull())
        .addPrimaryKeyConstraint("records_pk", ["kind", "id"]),
    );
    this.execute(
      this.queries.schema
        .createIndex("records_page")
        .ifNotExists()
        .on("records")
        .columns(["kind", "seq", "id"]),
    );
    this.execute(
      this.queries.schema.createIndex("records_sequence").ifNotExists().on("records").column("seq"),
    );
    this.execute(
      this.queries.schema
        .createTable("events")
        .ifNotExists()
        .addColumn("seq", "integer", (c) => c.primaryKey().autoIncrement())
        .addColumn("value", "text", (c) => c.notNull()),
    );
  }
  private cursor<Row>(query: Compilable<Row>): Iterable<Row> {
    const compiled = query.compile();
    const parameters = compiled.parameters.map((value) => {
      if (
        value === null ||
        typeof value === "string" ||
        typeof value === "number" ||
        value instanceof ArrayBuffer
      )
        return value;
      throw new TypeError("Unsupported SQLite parameter");
    });
    // The compiler owns the selected row shape; this bridge only executes it.
    return this.storage.sql.exec(compiled.sql, ...parameters) as Iterable<Row>;
  }
  private execute<Row>(query: Compilable<Row>): Row[] {
    return [...this.cursor(query)];
  }
  get<T>(kind: string, id: string): T | undefined {
    const row = this.execute(
      this.queries
        .selectFrom("records")
        .select("value")
        .where("kind", "=", kind)
        .where("id", "=", id),
    )[0];
    return row ? (JSON.parse(row.value) as T) : undefined;
  }
  require<T>(kind: string, id: string): T {
    const value = this.get<T>(kind, id);
    if (!value) throw new ApiError(404, "not_found", `${kind} not found`);
    return value;
  }
  put(
    kind: string,
    id: string,
    value: unknown,
    seq = (this.execute(
      this.queries.selectFrom("records").select("seq").orderBy("seq", "desc").limit(1),
    )[0]?.seq ?? 0) + 1,
  ): void {
    const encoded = encodeRow(value, kind, id);
    this.execute(
      this.queries
        .insertInto("records")
        .values({ kind, id, seq, value: encoded })
        .onConflict((c) => c.columns(["kind", "id"]).doUpdateSet({ value: encoded })),
    );
  }
  remove(kind: string, id: string): void {
    this.execute(this.queries.deleteFrom("records").where("kind", "=", kind).where("id", "=", id));
  }
  clear(kind: string): void {
    this.execute(this.queries.deleteFrom("records").where("kind", "=", kind));
  }
  /** Resolve the native position key when a streamed public item is finalized. */
  outputKey(itemId: string): string | undefined {
    return this.execute(
      this.queries
        .selectFrom("records")
        .select("id")
        .where("kind", "=", "output")
        .where(sql<string>`json_extract(value, '$.item.id')`, "=", itemId)
        .limit(1),
    )[0]?.id;
  }
  list<T>(
    kind: string,
    query: PageQuery,
    filter?: {
      field?: "agent_id" | "environment_id" | "turn_id" | "item.turn_id" | "resource.purpose";
      value?: string;
      expiresAfter?: number;
    },
  ): {
    object: "list";
    data: T[];
    has_more: boolean;
    first_id: string | null;
    last_id: string | null;
  } {
    let selection = this.queries
      .selectFrom("records")
      .select(["id", "value"])
      .where("kind", "=", kind);
    if (filter?.field !== undefined && filter.value !== undefined)
      selection = selection.where(
        sql<string>`json_extract(value, ${`$.${filter.field}`})`,
        "=",
        filter.value,
      );
    if (filter?.expiresAfter !== undefined)
      selection = selection.where((eb) =>
        eb.or([
          eb(sql<number>`json_extract(value, '$.resource.expires_at')`, "is", null),
          eb(
            sql<number>`json_extract(value, '$.resource.expires_at')`,
            ">",
            filter.expiresAfter ?? 0,
          ),
        ]),
      );
    if (query.after) {
      let cursorQuery = this.queries
        .selectFrom("records")
        .select(["seq", "id"])
        .where("kind", "=", kind)
        .where("id", "=", query.after);
      if (filter?.field !== undefined && filter.value !== undefined)
        cursorQuery = cursorQuery.where(
          sql<string>`json_extract(value, ${`$.${filter.field}`})`,
          "=",
          filter.value,
        );
      const cursor = this.execute(cursorQuery)[0];
      if (!cursor)
        throw new ApiError(400, "invalid_cursor", "Cursor does not belong to this collection");
      const comparison = query.order === "asc" ? ">" : "<";
      selection = selection.where((eb) =>
        eb.or([
          eb("seq", comparison, cursor.seq),
          eb.and([eb("seq", "=", cursor.seq), eb("id", comparison, cursor.id)]),
        ]),
      );
    }
    // Rows are consumed lazily, so a page never holds more than its byte budget.
    const visible: { id: string; value: string }[] = [];
    let size = 0;
    let has_more = false;
    for (const row of this.cursor(
      selection
        .orderBy("seq", query.order)
        .orderBy("id", query.order)
        .limit(query.limit + 1),
    )) {
      if (
        visible.length >= query.limit ||
        (visible.length > 0 && size + row.value.length > MAX_PAGE_CHARS)
      ) {
        has_more = true;
        break;
      }
      visible.push(row);
      size += row.value.length;
    }
    return {
      object: "list",
      data: visible.map((row) => JSON.parse(row.value) as T),
      has_more,
      first_id: visible[0]?.id ?? null,
      last_id: visible.at(-1)?.id ?? null,
    };
  }
  append(value: unknown): number {
    const row = this.execute(
      this.queries
        .insertInto("events")
        .values({ value: encodeRow(value) })
        .returning("seq"),
    )[0];
    if (!row) throw new Error("SQLite did not return the event sequence");
    return row.seq;
  }
  events<T>(after: number, limit = 100): { seq: number; event: T }[] {
    return this.execute(
      this.queries
        .selectFrom("events")
        .selectAll()
        .where("seq", ">", after)
        .orderBy("seq", "asc")
        .limit(limit),
    ).map((row) => ({ seq: row.seq, event: JSON.parse(row.value) as T }));
  }
  /** Remove every record and event. The schema stays, so the object remains usable. */
  purge(): void {
    this.execute(this.queries.deleteFrom("records"));
    this.execute(this.queries.deleteFrom("events"));
  }
  lastEvent(): number {
    return (
      this.execute(
        this.queries.selectFrom("events").select("seq").orderBy("seq", "desc").limit(1),
      )[0]?.seq ?? 0
    );
  }
  transaction<T>(
    callback: () => T &
      (T extends PromiseLike<unknown> | Effect.Effect<unknown, unknown, unknown> ? never : unknown),
  ): T {
    return this.storage.transactionSync(callback);
  }
}
