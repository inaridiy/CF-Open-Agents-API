import type { Encoded } from "./machine.js";

export interface StoredState {
  readonly state: Encoded;
  /** Advances whenever the state tag changes; command results from an older epoch are stale. */
  readonly epoch: number;
}

export interface OutboxEntry {
  readonly id: number;
  readonly command: Encoded;
  /** The epoch of the state that enqueued the command. */
  readonly epoch: number;
  /** A release runs even when the state moved on; any other stale command is dropped. */
  readonly release: boolean;
  readonly attempts: number;
  /** Not before this time (epoch milliseconds). */
  readonly due: number;
}

/**
 * Synchronous storage for machines. Every method is plain and total, so a transaction
 * over it can run inside a Durable Object's `transactionSync` together with the host's
 * own writes.
 */
export interface MachineStore {
  /** Runs `body` atomically; a throw rolls back every write it made. Nested calls join the outer one. */
  transaction<A>(body: () => A): A;
  load(machine: string): StoredState | undefined;
  save(machine: string, value: StoredState): void;
  enqueue(machine: string, entry: Omit<OutboxEntry, "id">): number;
  /** Pending commands in enqueue order. */
  outbox(machine: string): ReadonlyArray<OutboxEntry>;
  remove(id: number): void;
  reschedule(id: number, attempts: number, due: number): void;
}

/** The part of `DurableObjectStorage` the SQLite store uses. */
export interface SqliteStorage {
  readonly sql: {
    exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] };
  };
  transactionSync<T>(closure: () => T): T;
}

/** Keeps machines in two tables of the object's SQLite database, created on first use. */
export function sqliteStore(storage: SqliteStorage): MachineStore {
  const exec = (query: string, ...bindings: unknown[]) =>
    storage.sql.exec(query, ...bindings).toArray();
  exec(
    "CREATE TABLE IF NOT EXISTS _dm_state (machine TEXT PRIMARY KEY, state TEXT NOT NULL, epoch INTEGER NOT NULL)",
  );
  exec(
    "CREATE TABLE IF NOT EXISTS _dm_outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, machine TEXT NOT NULL, command TEXT NOT NULL, epoch INTEGER NOT NULL, release INTEGER NOT NULL, attempts INTEGER NOT NULL, due INTEGER NOT NULL)",
  );
  let depth = 0;
  return {
    transaction(body) {
      if (depth > 0) return body();
      depth++;
      try {
        return storage.transactionSync(body);
      } finally {
        depth--;
      }
    },
    load(machine) {
      const [row] = exec("SELECT state, epoch FROM _dm_state WHERE machine = ?", machine);
      if (!row) return;
      return { state: JSON.parse(String(row.state)) as Encoded, epoch: Number(row.epoch) };
    },
    save(machine, value) {
      exec(
        "INSERT INTO _dm_state (machine, state, epoch) VALUES (?, ?, ?) ON CONFLICT (machine) DO UPDATE SET state = excluded.state, epoch = excluded.epoch",
        machine,
        JSON.stringify(value.state),
        value.epoch,
      );
    },
    enqueue(machine, entry) {
      const [row] = exec(
        "INSERT INTO _dm_outbox (machine, command, epoch, release, attempts, due) VALUES (?, ?, ?, ?, ?, ?) RETURNING id",
        machine,
        JSON.stringify(entry.command),
        entry.epoch,
        entry.release ? 1 : 0,
        entry.attempts,
        entry.due,
      );
      return Number(row?.id);
    },
    outbox(machine) {
      return exec(
        "SELECT id, command, epoch, release, attempts, due FROM _dm_outbox WHERE machine = ? ORDER BY id",
        machine,
      ).map((row) => ({
        id: Number(row.id),
        command: JSON.parse(String(row.command)) as Encoded,
        epoch: Number(row.epoch),
        release: Number(row.release) === 1,
        attempts: Number(row.attempts),
        due: Number(row.due),
      }));
    },
    remove(id) {
      exec("DELETE FROM _dm_outbox WHERE id = ?", id);
    },
    reschedule(id, attempts, due) {
      exec("UPDATE _dm_outbox SET attempts = ?, due = ? WHERE id = ?", attempts, due, id);
    },
  };
}

/** An in-memory store with the same transaction semantics, for tests and models. */
export function memoryStore(): MachineStore {
  let states = new Map<string, StoredState>();
  let entries: Array<OutboxEntry & { readonly machine: string }> = [];
  let next = 1;
  let depth = 0;
  return {
    transaction(body) {
      if (depth > 0) return body();
      const saved = { states: new Map(states), entries: [...entries], next };
      depth++;
      try {
        return body();
      } catch (error) {
        ({ states, entries, next } = saved);
        throw error;
      } finally {
        depth--;
      }
    },
    load: (machine) => states.get(machine),
    save(machine, value) {
      states.set(machine, value);
    },
    enqueue(machine, entry) {
      const id = next++;
      entries.push({ ...entry, id, machine });
      return id;
    },
    outbox: (machine) =>
      entries
        .filter((entry) => entry.machine === machine)
        .map(({ machine: _machine, ...entry }) => entry),
    remove(id) {
      entries = entries.filter((entry) => entry.id !== id);
    },
    reschedule(id, attempts, due) {
      entries = entries.map((entry) => (entry.id === id ? { ...entry, attempts, due } : entry));
    },
  };
}
