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

import { InvalidCursor, RecordNotFound } from "./errors.js";
import type { Kind } from "./persistence/kind.js";
import type {
  ListFilter,
  Page,
  RecordStore,
  Sync,
  Transactional,
} from "./persistence/record-store.js";
import { encodeRow } from "./persistence/row.js";
import type { AgentSessionEvent, PageQuery } from "./protocol.js";

// A page stops growing past this many serialized characters, so a response stays
// far below the isolate's memory limit even when every record is at the row limit.
const MAX_PAGE_CHARS = 4 * 1024 * 1024;

interface Database {
  records: { kind: string; id: string; seq: number; value: string };
  events: { seq: Generated<number>; value: string };
}

/**
 * Kysely builds and types every query. Execution stays synchronous so a complete
 * state transition can use DO transactionSync, including rollback on a guard.
 * Kysely's async transaction() cannot express that platform contract.
 *
 * The one durable `RecordStore`: the inside of the persistence seam, free of Effect.
 */
export class SqlStore implements RecordStore, Transactional {
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
  get<A>(kind: Kind<A>, id: string): A | undefined {
    const row = this.execute(
      this.queries
        .selectFrom("records")
        .select("value")
        .where("kind", "=", kind)
        .where("id", "=", id),
    )[0];
    return row ? (JSON.parse(row.value) as A) : undefined;
  }
  require<A>(kind: Kind<A>, id: string): A {
    const value = this.get(kind, id);
    if (!value) throw new RecordNotFound({ kind, id });
    return value;
  }
  put<A>(
    kind: Kind<A>,
    id: string,
    value: NoInfer<A>,
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
  remove(kind: Kind<unknown>, id: string): void {
    this.execute(this.queries.deleteFrom("records").where("kind", "=", kind).where("id", "=", id));
  }
  clear(kind: Kind<unknown>): void {
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
  list<A>(kind: Kind<A>, query: PageQuery, filter?: ListFilter): Page<A> {
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
      if (!cursor) throw new InvalidCursor();
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
      data: visible.map((row) => JSON.parse(row.value) as A),
      has_more,
      first_id: visible[0]?.id ?? null,
      last_id: visible.at(-1)?.id ?? null,
    };
  }
  append(event: AgentSessionEvent): number {
    const row = this.execute(
      this.queries
        .insertInto("events")
        .values({ value: encodeRow(event) })
        .returning("seq"),
    )[0];
    if (!row) throw new Error("SQLite did not return the event sequence");
    return row.seq;
  }
  events(after: number, limit = 100): { seq: number; event: AgentSessionEvent }[] {
    return this.execute(
      this.queries
        .selectFrom("events")
        .selectAll()
        .where("seq", ">", after)
        .orderBy("seq", "asc")
        .limit(limit),
    ).map((row) => ({ seq: row.seq, event: JSON.parse(row.value) as AgentSessionEvent }));
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
  transaction<A>(closure: () => Sync<A>): A {
    return this.storage.transactionSync(closure);
  }
}
