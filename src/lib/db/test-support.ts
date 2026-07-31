import path from "node:path";

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

import { applyPragmas } from "./client";
import * as schema from "./schema";

/**
 * TEST-ONLY helpers. Nothing under `src/app` or `src/components` may import
 * this module -- it exists so every phase's tests can get a migrated database
 * the same way production does, and it is deliberately not part of the app's
 * import graph (so Next never bundles it).
 *
 * The migration is applied with `migrate()` from
 * drizzle-orm/better-sqlite3/migrator -- the *exact* call docker-entrypoint.sh
 * makes. Hand-rolling the loader (readdir + split on `--> statement-breakpoint`
 * + exec) is what these helpers replace: that path ignores
 * `drizzle/meta/_journal.json` entirely, so a journal entry whose `tag` no
 * longer matches its filename, or a missing entry, would keep every test green
 * while the container dies at startup.
 */
export const MIGRATIONS_FOLDER = path.resolve(import.meta.dirname, "../../../drizzle");

/** Apply every recorded migration to an already-open connection. */
export function applyMigrations(connection: Database.Database): void {
  migrate(drizzle(connection), { migrationsFolder: MIGRATIONS_FOLDER });
}

/**
 * Apply every recorded migration to the database file at `dbPath`, on a
 * connection that is closed again before returning -- for tests that then
 * point `DATABASE_PATH` at that file and go through the real `getDb()`
 * singleton.
 */
export function applyMigrationsAt(dbPath: string): void {
  const connection = new Database(dbPath);
  applyMigrations(connection);
  connection.close();
}

/**
 * A migrated in-memory database with the production PRAGMAs applied -- notably
 * `foreign_keys = ON`, which the schema's cascade graph depends on.
 */
export function freshDatabase(): Database.Database {
  const connection = new Database(":memory:");
  applyPragmas(connection);
  applyMigrations(connection);
  return connection;
}

/** `freshDatabase()` plus a schema-aware Drizzle handle for `db.query.*`. */
export function freshDrizzle(): {
  connection: Database.Database;
  db: BetterSQLite3Database<typeof schema>;
} {
  const connection = freshDatabase();
  return { connection, db: drizzle(connection, { schema }) };
}
