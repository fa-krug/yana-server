import path from "node:path";

import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

import { getDb } from "./client";

/**
 * Where the generated migrations live, resolved from the working directory.
 *
 * `process.cwd()` rather than a module-relative path: this module is bundled by
 * webpack, so `import.meta.dirname` would point somewhere inside `.next/server`
 * -- the trick `src/lib/db/test-support.ts` uses is correct for a file Vitest
 * loads from source and wrong for one Next compiles. Every way this app runs has
 * the project root (or `/app` in the image, which is the same shape) as its
 * working directory: `next dev`, `next start`, and the standalone `node
 * server.js` with `drizzle/` copied beside it. Verified for the standalone
 * server, not assumed.
 */
export const MIGRATIONS_FOLDER = path.join(process.cwd(), "drizzle");

/**
 * The one call to drizzle's `migrate()` in this repository.
 *
 * Production (`src/lib/startup.ts`, at server start) and the test fixtures
 * (`src/lib/db/test-support.ts`) both come through here, which is the property
 * CLAUDE.md's testing convention depends on: a hand-rolled loader that `exec`s
 * the `.sql` files ignores `drizzle/meta/_journal.json`, so a stale entry would
 * stay green in CI and die at container start. Same function, same journal, one
 * behaviour.
 *
 * A documented exception to "every write goes through `writeTransaction()`":
 * `migrate()` runs its own transaction around the DDL and owns the
 * `__drizzle_migrations` bookkeeping. It is synchronous, like everything else
 * better-sqlite3 does.
 */
export function applyMigrations<TSchema extends Record<string, unknown>>(
  db: BetterSQLite3Database<TSchema>,
  migrationsFolder: string = MIGRATIONS_FOLDER,
): void {
  migrate(db, { migrationsFolder });
}

/**
 * Bring the application's own database up to date. Called once at server start;
 * a no-op when every migration in the journal has already been applied.
 */
export function applyPendingMigrations(): void {
  applyMigrations(getDb());
}
