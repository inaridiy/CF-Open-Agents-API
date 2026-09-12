import {
  type Compilable,
  DummyDriver,
  type Generated,
  Kysely,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
} from "kysely";
import type { PageQuery } from "./protocol.js";
import { ApiError } from "./protocol.js";

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
  private execute<Row>(query: Compilable<Row>): Row[] {
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
    return this.storage.sql.exec(compiled.sql, ...parameters).toArray() as Row[];
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
    this.execute(
      this.queries
        .insertInto("records")
        .values({ kind, id, seq, value: JSON.stringify(value) })
        .onConflict((c) => c.columns(["kind", "id"]).doUpdateSet({ value: JSON.stringify(value) })),
    );
  }
  remove(kind: string, id: string): void {
    this.execute(this.queries.deleteFrom("records").where("kind", "=", kind).where("id", "=", id));
  }
  clear(kind: string): void {
    this.execute(this.queries.deleteFrom("records").where("kind", "=", kind));
  }
  list<T>(
    kind: string,
    query: PageQuery,
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
    if (query.after) {
      const cursor = this.execute(
        this.queries
          .selectFrom("records")
          .select(["seq", "id"])
          .where("kind", "=", kind)
          .where("id", "=", query.after),
      )[0];
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
    const rows = this.execute(
      selection
        .orderBy("seq", query.order)
        .orderBy("id", query.order)
        .limit(query.limit + 1),
    );
    const visible = rows.slice(0, query.limit);
    return {
      object: "list",
      data: visible.map((row) => JSON.parse(row.value) as T),
      has_more: rows.length > query.limit,
      first_id: visible[0]?.id ?? null,
      last_id: visible.at(-1)?.id ?? null,
    };
  }
  append(value: unknown): number {
    const row = this.execute(
      this.queries
        .insertInto("events")
        .values({ value: JSON.stringify(value) })
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
  lastEvent(): number {
    return (
      this.execute(
        this.queries.selectFrom("events").select("seq").orderBy("seq", "desc").limit(1),
      )[0]?.seq ?? 0
    );
  }
  transaction<T>(callback: () => T): T {
    return this.storage.transactionSync(callback);
  }
}
