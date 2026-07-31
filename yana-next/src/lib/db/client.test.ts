import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

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
