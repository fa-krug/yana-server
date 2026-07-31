import path from "node:path";

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

import * as schema from "./schema";

export const DB_PATH = process.env.DATABASE_PATH ?? path.join(process.cwd(), "data", "yana.db");

/**
 * The PRAGMA set from the retired Django backend
 * (core/db/backends/sqlite3/base.py). These are not defaults and do not
 * survive a framework change on their own.
 */
export function applyPragmas(connection: Database.Database): void {
  // Concurrency: readers do not block the writer.
  connection.pragma("journal_mode = WAL");
  // Balanced durability -- survives process crash, not OS crash.
  connection.pragma("synchronous = NORMAL");
  // Negative means KiB, so this is 64 MB.
  connection.pragma("cache_size = -64000");
  // 256 MB memory-mapped I/O; should be >= cache_size.
  connection.pragma("mmap_size = 268435456");
  connection.pragma("temp_store = MEMORY");
  connection.pragma("page_size = 4096");
  // better-sqlite3 leaves this OFF by default. Django turned it on, and the
  // schema's cascade behavior depends on it.
  connection.pragma("foreign_keys = ON");
  // 30s. Necessary but NOT sufficient on its own -- see the transaction note.
  connection.pragma("busy_timeout = 30000");
}

let cached: BetterSQLite3Database<typeof schema> | undefined;

export function getDb(): BetterSQLite3Database<typeof schema> {
  if (cached) return cached;

  const connection = new Database(DB_PATH);
  applyPragmas(connection);
  cached = drizzle(connection, { schema });
  return cached;
}

/**
 * Run `work` inside a BEGIN IMMEDIATE transaction.
 *
 * SQLite's default DEFERRED mode takes a read lock first and upgrades on the
 * first write. Two concurrent upgraders deadlock, and busy_timeout cannot help
 * because neither can proceed. IMMEDIATE takes the write lock up front, so one
 * waits instead. Every write path uses this.
 *
 * `$client` is drizzle-orm's own escape hatch back to the raw better-sqlite3
 * handle (see `construct()` in drizzle-orm/better-sqlite3/driver.js, which sets
 * `db.$client = client` unconditionally). It is documented as an adapter
 * internal that can change shape across versions, so this call site is the
 * single place coupled to it -- verified present and working at runtime on
 * drizzle-orm@0.45.2 before relying on it here. If a future upgrade removes or
 * renames it, this is the only line that needs to change.
 */
export function writeTransaction<T>(work: (tx: BetterSQLite3Database<typeof schema>) => T): T {
  const db = getDb();
  const connection = (db as unknown as { $client: Database.Database }).$client;
  connection.exec("BEGIN IMMEDIATE");
  try {
    const result = work(db);
    connection.exec("COMMIT");
    return result;
  } catch (error) {
    connection.exec("ROLLBACK");
    throw error;
  }
}
