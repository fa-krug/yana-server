import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyPragmas } from "./client";

function read(connection: Database.Database, pragma: string): unknown {
  const row = connection.pragma(pragma, { simple: true });
  return row;
}

describe("applyPragmas", () => {
  it("applies every setting the Django backend applied", () => {
    const connection = new Database(":memory:");
    applyPragmas(connection);

    // An in-memory database cannot use WAL, so journal_mode is asserted
    // separately against a file database below. mmap_size is asserted there
    // too: verified against this SQLite build (better-sqlite3@13.0.2, node
    // v25.6.1, darwin/arm64), PRAGMA mmap_size reads back as `undefined` on a
    // `:memory:` connection even after being set without error -- mmap has no
    // file to map, so the setting has nothing to report. Setting it here is
    // still correct and harmless; it just isn't observable on this connection.
    expect(read(connection, "synchronous")).toBe(1); // NORMAL
    expect(read(connection, "cache_size")).toBe(-64000);
    expect(read(connection, "temp_store")).toBe(2); // MEMORY
    expect(read(connection, "foreign_keys")).toBe(1);
    connection.close();
  });

  describe("file database", () => {
    // The brief's original test hardcodes `/tmp/yana-pragma-${process.pid}.db`.
    // That leaks a file per run and ignores the OS-provided temp directory, so
    // the path is resolved via node:os instead and removed after the test. The
    // journal_mode assertion itself is unchanged; mmap_size moved here from the
    // in-memory test above for the reason noted there.
    let dbPath: string;

    afterEach(() => {
      if (dbPath) {
        for (const suffix of ["", "-shm", "-wal"]) {
          fs.rmSync(`${dbPath}${suffix}`, { force: true });
        }
      }
    });

    it("enables WAL on a file database", () => {
      dbPath = path.join(os.tmpdir(), `yana-pragma-${process.pid}.db`);
      const connection = new Database(dbPath);
      applyPragmas(connection);

      expect(read(connection, "journal_mode")).toBe("wal");
      expect(read(connection, "mmap_size")).toBe(268435456);
      connection.close();
    });
  });

  it("enforces foreign keys, which better-sqlite3 leaves off by default", () => {
    const connection = new Database(":memory:");
    applyPragmas(connection);
    connection.exec("CREATE TABLE parent (id INTEGER PRIMARY KEY)");
    connection.exec(
      "CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id))",
    );

    expect(() => connection.exec("INSERT INTO child (parent_id) VALUES (999)")).toThrow(
      /FOREIGN KEY constraint failed/,
    );
    connection.close();
  });
});

describe("writeTransaction", () => {
  // getDb()/writeTransaction() share one process-wide singleton connection by
  // design (see client.ts). To exercise that singleton for real -- not a mock
  // -- each test points DATABASE_PATH at its own temp file and forces a fresh
  // module instance via vi.resetModules() + a dynamic import, so the
  // module-level `cached` connection and transaction-depth counter start
  // clean every time instead of leaking state between tests.
  let dbPath: string;
  let client: typeof import("./client");

  function raw(db: unknown): Database.Database {
    // Same escape hatch client.ts itself uses to reach the raw better-sqlite3
    // handle -- needed here to set up a fixture table and to run raw SQL
    // inside `work()`, since `schema` is still the empty Phase-1 barrel.
    return (db as { $client: Database.Database }).$client;
  }

  beforeEach(async () => {
    vi.resetModules();
    dbPath = path.join(
      os.tmpdir(),
      `yana-writeTransaction-${process.pid}-${Math.random().toString(36).slice(2)}.db`,
    );
    process.env.DATABASE_PATH = dbPath;
    client = await import("./client");
    raw(client.getDb()).exec("CREATE TABLE items (id INTEGER PRIMARY KEY, value TEXT)");
  });

  afterEach(() => {
    delete process.env.DATABASE_PATH;
    const connection = raw(client.getDb());
    if (connection.open) connection.close();
    for (const suffix of ["", "-shm", "-wal"]) {
      fs.rmSync(`${dbPath}${suffix}`, { force: true });
    }
  });

  it("commits a successful write, visible afterward", () => {
    client.writeTransaction((tx) => {
      raw(tx).exec("INSERT INTO items (value) VALUES ('a')");
    });

    const rows = raw(client.getDb()).prepare("SELECT value FROM items").all();
    expect(rows).toEqual([{ value: "a" }]);
  });

  it("rolls back when work throws, and the original error propagates", () => {
    class BoomError extends Error {}

    expect(() =>
      client.writeTransaction((tx) => {
        raw(tx).exec("INSERT INTO items (value) VALUES ('b')");
        throw new BoomError("boom");
      }),
    ).toThrow(BoomError);

    const rows = raw(client.getDb()).prepare("SELECT value FROM items").all();
    expect(rows).toEqual([]);
  });

  it("preserves the original error even when the rollback that follows also fails", () => {
    // Honestly provoked, not mocked: work() closes the connection itself
    // before throwing, so the ROLLBACK inside writeTransaction's catch block
    // hits an already-closed connection and throws for real. (Verified
    // separately: better-sqlite3 raises "The database connection is not
    // open" in exactly this situation.)
    class BoomError extends Error {}
    let thrown: unknown;

    try {
      client.writeTransaction((tx) => {
        raw(tx).exec("INSERT INTO items (value) VALUES ('c')");
        raw(tx).close();
        throw new BoomError("boom");
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(BoomError);
    expect((thrown as Error).message).toBe("boom");
    // The rollback failure must not be silently discarded either.
    expect((thrown as Error).cause).toBeInstanceOf(Error);
  });

  it("rolls back and preserves the original error when COMMIT itself fails", () => {
    // Bonus coverage for the COMMIT-failure path: work() succeeds and closes
    // the connection as its last act, so the subsequent COMMIT throws for
    // real, driving the same rollback-preserves-original-error path proven
    // above but from the commit side instead of the work side.
    let thrown: unknown;

    try {
      client.writeTransaction((tx) => {
        raw(tx).exec("INSERT INTO items (value) VALUES ('d')");
        raw(tx).close();
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(/database connection is not open/i);
  });

  it("lets a nested writeTransaction join the outer transaction", () => {
    client.writeTransaction((outerTx) => {
      raw(outerTx).exec("INSERT INTO items (value) VALUES ('outer')");

      client.writeTransaction((innerTx) => {
        raw(innerTx).exec("INSERT INTO items (value) VALUES ('inner')");
      });
    });

    const rows = raw(client.getDb()).prepare("SELECT value FROM items ORDER BY id").all();
    expect(rows).toEqual([{ value: "outer" }, { value: "inner" }]);
  });

  it("does not leave the depth counter elevated after a failed transaction", () => {
    expect(() =>
      client.writeTransaction(() => {
        throw new Error("boom");
      }),
    ).toThrow("boom");

    // If the depth counter leaked (stayed above 0) after that failure, this
    // next call would wrongly take the "nested" branch and skip BEGIN
    // IMMEDIATE -- there would be no active transaction while `work` runs.
    let sawTransactionOpen = false;
    client.writeTransaction((tx) => {
      sawTransactionOpen = raw(tx).inTransaction;
      raw(tx).exec("INSERT INTO items (value) VALUES ('after-failure')");
    });

    expect(sawTransactionOpen).toBe(true);
    const rows = raw(client.getDb()).prepare("SELECT value FROM items").all();
    expect(rows).toEqual([{ value: "after-failure" }]);
  });

  // better-sqlite3 is entirely synchronous: an async `work` callback returns a
  // Promise immediately, before the awaited body inside it has run. Without a
  // guard, writeTransaction would run COMMIT (or, nested, return) right then --
  // committing before the callback's real work happens, with those writes
  // landing outside any transaction and no error raised anywhere. These tests
  // are the RED case a silent misuse would otherwise sail through: a
  // `work` that returns a Promise must be rejected loudly, and rejecting it
  // must not leave the connection or the depth counter in a bad state.
  describe("rejects an async (thenable-returning) work callback", () => {
    // Deliberately bypassing the NotPromise<T> compile-time guard with `any`
    // to exercise the runtime one (rejectIfThenable) -- callers who get past
    // the type system some other way (`any`, a pre-built callback reference,
    // a conditionally-async function) must still be caught at runtime.
    function callWithAsyncWork(sql: string): unknown {
      const asyncWork = async (tx: ReturnType<typeof client.getDb>) => {
        raw(tx).exec(sql);
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see comment above
      return client.writeTransaction(asyncWork as any);
    }

    it("throws synchronously instead of silently accepting the Promise", () => {
      expect(() => callWithAsyncWork("INSERT INTO items (value) VALUES ('async')")).toThrow(
        /writeTransaction.*Promise/i,
      );
    });

    it("commits nothing from the async body, and rolls back the BEGIN it opened", () => {
      try {
        callWithAsyncWork("INSERT INTO items (value) VALUES ('async-should-not-land')");
      } catch {
        // expected -- asserted in the previous test
      }

      const rows = raw(client.getDb()).prepare("SELECT value FROM items").all();
      expect(rows).toEqual([]);
      // The connection itself must not be left mid-transaction either.
      expect(raw(client.getDb()).inTransaction).toBe(false);
    });

    it("leaves the depth counter clean, so a subsequent writeTransaction still works", () => {
      try {
        callWithAsyncWork("INSERT INTO items (value) VALUES ('async-2')");
      } catch {
        // expected
      }

      let sawTransactionOpen = false;
      client.writeTransaction((tx) => {
        sawTransactionOpen = raw(tx).inTransaction;
        raw(tx).exec("INSERT INTO items (value) VALUES ('after-async-rejection')");
      });

      expect(sawTransactionOpen).toBe(true);
      const rows = raw(client.getDb()).prepare("SELECT value FROM items").all();
      expect(rows).toEqual([{ value: "after-async-rejection" }]);
    });

    it("rejects a nested async callback the same way", () => {
      const asyncWork = async (tx: ReturnType<typeof client.getDb>) => {
        raw(tx).exec("INSERT INTO items (value) VALUES ('nested-async')");
      };

      expect(() =>
        client.writeTransaction((outerTx) => {
          raw(outerTx).exec("INSERT INTO items (value) VALUES ('outer-before-nested-async')");
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see callWithAsyncWork above
          client.writeTransaction(asyncWork as any);
        }),
      ).toThrow(/writeTransaction.*Promise/i);

      // The outer transaction must roll back too -- the nested rejection
      // propagates as a thrown error out of the outer `work`.
      const rows = raw(client.getDb()).prepare("SELECT value FROM items").all();
      expect(rows).toEqual([]);
    });
  });
});
