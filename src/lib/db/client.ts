import fs from "node:fs";
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
 *
 * Deviation from base.py: Django's `_set_pragma` logs a warning and continues
 * when a PRAGMA fails, so one bad setting couldn't take the whole connection
 * down. `connection.pragma()` here throws on failure instead, so a failing
 * PRAGMA fails `getDb()` hard rather than limping on with a partially-tuned
 * connection. That's the better behavior for this port (a half-applied
 * PRAGMA set is a worse silent failure mode than refusing to start), but it
 * is a deliberate deviation from "exactly those in base.py", not an oversight.
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
  // Inert as written: SQLite documents `page_size` as a no-op once the
  // database is already in WAL mode (set two lines above, in the same
  // function), and the compiled default has been 4096 for years regardless.
  // So this line has zero behavioral effect here -- it is a faithful port of
  // an already-inert setting from base.py, kept for parity rather than
  // effect. Do not reorder the PRAGMAs to make it "work"; matching Django's
  // ordering exactly is the point.
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

  // Fresh clone / first local run: DATABASE_PATH's directory is not created
  // by anything else (the container does `mkdir -p /app/data`, but that's
  // container-only), so create it here or `new Database()` throws
  // `SqliteError: unable to open database file`.
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

  const connection = new Database(DB_PATH);
  applyPragmas(connection);
  cached = drizzle(connection, { schema });
  return cached;
}

// Depth of nested writeTransaction() calls currently in progress on the
// singleton connection. 0 means no transaction is open. Only the outermost
// call (the one that observes depth 0 on entry) issues BEGIN IMMEDIATE /
// COMMIT / ROLLBACK; see writeTransaction() below.
let transactionDepth = 0;

/**
 * Roll back after `originalError` (raised by `work()` or by a failed COMMIT),
 * then (re)throw. The original error always wins: if the ROLLBACK itself also
 * fails, that failure is attached as `originalError.cause` rather than
 * replacing it, so a caller's `catch` still sees the real failure (its type,
 * message, stack) and a rollback that failed is not silently discarded --
 * it's discoverable via `.cause` for anyone who logs or inspects it.
 *
 * `originalError` is typed `unknown` because `work()` and `connection.exec`
 * can throw anything, not just `Error` -- not a place where `any` applies.
 */
function rollbackAfter(connection: Database.Database, originalError: unknown): never {
  try {
    connection.exec("ROLLBACK");
  } catch (rollbackError) {
    if (originalError instanceof Error) {
      originalError.cause = rollbackError;
    } else {
      // A non-Error was thrown (e.g. `throw "boom"`), so there's no object to
      // attach `.cause` to without changing its identity. Wrapping is the
      // only way left to avoid losing either failure.
      throw new Error("writeTransaction: ROLLBACK failed after a non-Error was thrown", {
        cause: { originalError, rollbackError },
      });
    }
  }
  throw originalError;
}

/**
 * Distributes `never` over a `Promise` return type so a callback typed
 * `(tx) => NotPromise<T>` cannot be satisfied by an `async` arrow function or
 * any function that returns a `Promise` -- see `writeTransaction` below for
 * why that must be rejected. This is the type-level half of that guard; the
 * runtime half is `rejectIfThenable`.
 */
type NotPromise<T> = T extends Promise<unknown> ? never : T;

/**
 * Throws loudly if `value` is a thenable. better-sqlite3 is entirely
 * synchronous, so if `work()` returns a Promise, `writeTransaction` would
 * otherwise run COMMIT (or the nested return) immediately, before that
 * promise ever settles -- committing (or "completing") before the awaited
 * body has actually run, with every write inside it landing outside any
 * transaction and no error anywhere. This is a runtime backstop for exactly
 * that case: it catches an `async` callback even when TypeScript's
 * `NotPromise<T>` constraint on `work`'s declared type is bypassed (`any`,
 * a callback assigned before being passed, a conditional return that is only
 * sometimes a promise, etc).
 */
function rejectIfThenable(value: unknown): void {
  if (
    typeof value === "object" &&
    value !== null &&
    "then" in value &&
    typeof (value as { then: unknown }).then === "function"
  ) {
    throw new TypeError(
      "writeTransaction: work() returned a Promise (an async callback?). " +
        "better-sqlite3 is synchronous, so the transaction would commit (or, " +
        "nested, return) before your awaited code ever runs, silently writing " +
        "outside any transaction. Make the callback synchronous: remove " +
        "`async` and do not return a Promise from it. If you need to await " +
        "something, do it before calling writeTransaction() and pass already-" +
        "resolved values in.",
    );
  }
}

/**
 * Run `work` inside a BEGIN IMMEDIATE transaction.
 *
 * SQLite's default DEFERRED mode takes a read lock first and upgrades on the
 * first write. Two concurrent upgraders deadlock, and busy_timeout cannot help
 * because neither can proceed. IMMEDIATE takes the write lock up front, so one
 * waits instead. Every write path uses this.
 *
 * Nesting joins the outer transaction rather than erroring or starting a
 * second one (SQLite rejects a nested BEGIN outright). The outermost call
 * owns BEGIN IMMEDIATE / COMMIT / ROLLBACK; a nested call just runs `work`
 * against the same connection and returns. This deliberately does NOT use
 * SAVEPOINTs, so a nested call gets no independent rollback: if inner work
 * throws and an outer caller catches that and continues anyway, nothing is
 * actually rolled back until the outermost frame commits or rolls back. That
 * is the same semantic Django's `atomic()` gives without savepoints, and it
 * is what phases 2-13 need. A future phase that needs an inner call to roll
 * back independently of its caller needs SAVEPOINT support, which this
 * function does not provide.
 *
 * `$client` is drizzle-orm's own escape hatch back to the raw better-sqlite3
 * handle (see `construct()` in drizzle-orm/better-sqlite3/driver.js, which sets
 * `db.$client = client` unconditionally). It is documented as an adapter
 * internal that can change shape across versions, so this call site is the
 * single place coupled to it -- verified present and working at runtime on
 * drizzle-orm@0.45.2 before relying on it here. If a future upgrade removes or
 * renames it, this is the only line that needs to change.
 */
export function writeTransaction<T>(
  work: (tx: BetterSQLite3Database<typeof schema>) => NotPromise<T>,
): T {
  const db = getDb();

  if (transactionDepth > 0) {
    const result = work(db);
    rejectIfThenable(result);
    return result as T;
  }

  const connection = (db as unknown as { $client: Database.Database }).$client;
  transactionDepth++;
  try {
    connection.exec("BEGIN IMMEDIATE");
    let result: T;
    try {
      const workResult = work(db);
      rejectIfThenable(workResult);
      result = workResult as T;
    } catch (workError) {
      rollbackAfter(connection, workError);
    }

    try {
      connection.exec("COMMIT");
    } catch (commitError) {
      // COMMIT failed, so the transaction may still be open (SQLite did not
      // consider it committed). Roll back to leave the connection in a known,
      // clean state -- otherwise the next writeTransaction() call would issue
      // BEGIN IMMEDIATE while, as far as SQLite is concerned, still logically
      // inside this one -- then propagate the commit failure itself.
      rollbackAfter(connection, commitError);
    }
    return result;
  } finally {
    // Decremented unconditionally via `finally`, on every path -- success,
    // work() failure, and commit failure alike -- so a thrown error here can
    // never leave the depth counter elevated. A stuck counter would make
    // every subsequent writeTransaction() call silently take the "nested"
    // branch above and skip BEGIN IMMEDIATE forever.
    transactionDepth--;
  }
}
