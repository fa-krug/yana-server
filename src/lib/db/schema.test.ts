import type Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import * as schema from "./schema";
import { freshDatabase, freshDrizzle } from "./test-support";

/** Rows a foreign-key cascade test needs beneath one user. */
function seedOwnershipGraph(connection: Database.Database): void {
  connection.exec(`
    INSERT INTO users (id, email) VALUES ('u1', 'a@b.c');
    INSERT INTO user_settings (user_id) VALUES ('u1');
    INSERT INTO tags (id, name, user_id) VALUES (1, 'News', 'u1');
    INSERT INTO feeds (id, name, user_id) VALUES (1, 'f', 'u1');
    INSERT INTO feed_tags (feed_id, tag_id) VALUES (1, 1);
    INSERT INTO articles (id, name, identifier, date, feed_id) VALUES (1, 'a', 'i', 0, 1);
    INSERT INTO article_blocks (id, article_id, parent_id, position, kind)
      VALUES (1, 1, NULL, 0, 'list');
    INSERT INTO article_blocks (id, article_id, parent_id, position, kind)
      VALUES (2, 1, 1, 0, 'list_item');
    INSERT INTO article_blocks (id, article_id, parent_id, position, kind)
      VALUES (3, 1, 2, 0, 'paragraph');
    INSERT INTO article_inline_runs (block_id, position, text) VALUES (3, 0, 'hello');
    INSERT INTO article_images (content_hash, file, content_type, byte_size)
      VALUES ('h', 'f.webp', 'image/webp', 10);
  `);
}

function count(connection: Database.Database, table: string): number {
  return (connection.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

describe("migrations", () => {
  it("creates every expected table", () => {
    const connection = freshDatabase();
    const names = connection
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((row) => (row as { name: string }).name);

    for (const expected of [
      "users",
      "user_settings",
      "feeds",
      "tags",
      "feed_tags",
      "articles",
      "article_blocks",
      "article_inline_runs",
      "article_images",
      "jobs",
      "reddit_subreddits",
      "youtube_channels",
    ]) {
      expect(names).toContain(expected);
    }
    // migrate() -- the same call docker-entrypoint.sh makes -- records what it
    // applied here. Asserted so the extra table is documented rather than a
    // surprise for whoever next reads this list.
    expect(names).toContain("__drizzle_migrations");
    connection.close();
  });

  it("reproduces every article index", () => {
    const connection = freshDatabase();
    const names = connection
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='articles'")
      .all()
      .map((row) => (row as { name: string }).name);

    for (const expected of [
      "articles_feed_identifier_idx",
      "articles_feed_date_idx",
      "articles_date_idx",
      "articles_read_idx",
      "articles_starred_idx",
      "articles_feed_read_date_idx",
      "articles_created_id_idx",
      "articles_feed_created_idx",
    ]) {
      expect(names).toContain(expected);
    }
    connection.close();
  });

  it("keeps uniq_block_position UNIQUE alongside the tree index", () => {
    const connection = freshDatabase();
    const rows = connection
      .prepare(
        "SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='article_blocks'",
      )
      .all() as { name: string; sql: string | null }[];

    const unique = rows.find((row) => row.name === "uniq_block_position");
    expect(unique?.sql).toMatch(/CREATE UNIQUE INDEX/);
    expect(rows.map((row) => row.name)).toContain("article_blocks_tree_idx");
    connection.close();
  });

  it("keeps Django's redundant display_name index next to the unique one", () => {
    const connection = freshDatabase();
    const names = connection
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='reddit_subreddits'")
      .all()
      .map((row) => (row as { name: string }).name);

    expect(names).toContain("reddit_subreddits_name_unique");
    expect(names).toContain("reddit_subreddits_name_idx");
    connection.close();
  });

  describe("CHECK constraints ported from Django's field types", () => {
    it("rejects negative positions and sizes, as Positive*IntegerField did", () => {
      const connection = freshDatabase();
      seedOwnershipGraph(connection);

      expect(() =>
        connection.exec(
          "INSERT INTO article_blocks (article_id, position, kind) VALUES (1, -1, 'paragraph')",
        ),
      ).toThrow(/CHECK constraint failed/);
      expect(() =>
        connection.exec(
          "INSERT INTO article_blocks (article_id, position, kind, level) VALUES (1, 9, 'heading', -1)",
        ),
      ).toThrow(/CHECK constraint failed/);
      expect(() =>
        connection.exec(
          "INSERT INTO article_inline_runs (block_id, position, text) VALUES (3, -1, 'x')",
        ),
      ).toThrow(/CHECK constraint failed/);
      expect(() =>
        connection.exec(
          "INSERT INTO article_images (content_hash, file, content_type, byte_size) " +
            "VALUES ('h2', 'f2', 'image/webp', -1)",
        ),
      ).toThrow(/CHECK constraint failed/);
      expect(() =>
        connection.exec(
          "INSERT INTO article_images (content_hash, file, content_type, byte_size, width) " +
            "VALUES ('h3', 'f3', 'image/webp', 1, -1)",
        ),
      ).toThrow(/CHECK constraint failed/);
      expect(() =>
        connection.exec(
          "INSERT INTO article_images (content_hash, file, content_type, byte_size, height) " +
            "VALUES ('h4', 'f4', 'image/webp', 1, -1)",
        ),
      ).toThrow(/CHECK constraint failed/);
      connection.close();
    });

    it("still accepts NULL in the nullable columns, exactly as Django did", () => {
      // `NULL >= 0` evaluates to NULL, which SQLite treats as satisfied. That
      // is why the checks need no `OR ... IS NULL` half.
      const connection = freshDatabase();
      seedOwnershipGraph(connection);

      expect(() =>
        connection.exec(
          "INSERT INTO article_blocks (article_id, position, kind, level) VALUES (1, 9, 'heading', NULL)",
        ),
      ).not.toThrow();
      expect(() =>
        connection.exec(
          "INSERT INTO article_images (content_hash, file, content_type, byte_size, width, height) " +
            "VALUES ('h5', 'f5', 'image/webp', 1, NULL, NULL)",
        ),
      ).not.toThrow();
      connection.close();
    });

    it("rejects malformed JSON before it becomes an unreadable row", () => {
      const connection = freshDatabase();
      connection.exec("INSERT INTO users (id, email) VALUES ('u1', 'a@b.c')");

      expect(() =>
        connection.exec(
          "INSERT INTO feeds (name, user_id, options) VALUES ('f', 'u1', 'not json')",
        ),
      ).toThrow(/CHECK constraint failed/);
      expect(() =>
        connection.exec("INSERT INTO jobs (kind, payload) VALUES ('k', '{oops')"),
      ).toThrow(/CHECK constraint failed/);
      connection.close();
    });
  });

  it("cascades a user's whole object graph away, but not the shared images", () => {
    // The cascade graph is the schema's most consequential runtime behavior and
    // it only works while `foreign_keys = ON`, which applyPragmas() guarantees.
    // Verified RED: the same graph on a connection with `foreign_keys = OFF`
    // leaves every child row behind. A future phase that opens a connection
    // without applyPragmas() silently accumulates orphans everywhere.
    const connection = freshDatabase();
    seedOwnershipGraph(connection);

    connection.exec("DELETE FROM users WHERE id = 'u1'");

    for (const table of [
      "users",
      "user_settings",
      "tags",
      "feeds",
      "feed_tags",
      "articles",
      "article_blocks",
      "article_inline_runs",
    ]) {
      expect(count(connection, table), `${table} should have been cascaded away`).toBe(0);
    }
    // Unowned by design: images are deduplicated across users, so reaping
    // orphans is a later phase's scheduled job, not a foreign key.
    expect(count(connection, "article_images")).toBe(1);
    connection.close();
  });

  // The next two tests are a matched pair guarding one documented SQLite
  // behavior: NULLs are distinct in a unique index, so uniq_block_position
  // covers nested rows and cannot cover root-level ones. Either test alone
  // proves nothing -- the first passes even if the index were dropped or
  // downgraded to a plain index, and the second says nothing about roots.
  it("rejects a duplicate (article, parent, position) among nested blocks", () => {
    const connection = freshDatabase();
    seedOwnershipGraph(connection);
    const insert = connection.prepare(
      "INSERT INTO article_blocks (article_id, parent_id, position, kind) VALUES (?, ?, ?, ?)",
    );

    insert.run(1, 1, 7, "paragraph");
    expect(() => insert.run(1, 1, 7, "paragraph")).toThrow(/UNIQUE constraint failed/);
    connection.close();
  });

  it("does not constrain root-level block positions, which is why the writer must", () => {
    const connection = freshDatabase();
    seedOwnershipGraph(connection);
    const insert = connection.prepare(
      "INSERT INTO article_blocks (article_id, parent_id, position, kind) VALUES (?, NULL, ?, ?)",
    );

    insert.run(1, 5, "paragraph");
    expect(() => insert.run(1, 5, "paragraph")).not.toThrow();
    connection.close();
  });
});

describe("updatedAt", () => {
  // `DEFAULT (unixepoch())` only covers the insert; Django's `auto_now=True`
  // rewrote the column on every save. `$onUpdate` is the port of that, and it
  // is client-side, so only a write through Drizzle exercises it.
  //
  // These columns are whole seconds, so "greater than before" would flake when
  // both writes land in the same second. The row is seeded with an explicitly
  // old timestamp instead, and the assertion is that the update moved it
  // forward past that -- deterministic, and no sleep.
  const seeded = new Date(1_000_000_000_000); // 2001-09-09

  function isAfterSeeded(value: Date | null | undefined): boolean {
    return value instanceof Date && value.getTime() > seeded.getTime();
  }

  it("moves forward on every table that declares it", () => {
    const { connection, db } = freshDrizzle();
    const stamps = { createdAt: seeded, updatedAt: seeded };

    db.insert(schema.users)
      .values({ id: "u1", email: "a@b.c", ...stamps })
      .run();
    db.insert(schema.userSettings)
      .values({ userId: "u1", ...stamps })
      .run();
    db.insert(schema.feeds)
      .values({ id: 1, name: "f", userId: "u1", ...stamps })
      .run();
    db.insert(schema.tags)
      .values({ id: 1, name: "t", userId: "u1", ...stamps })
      .run();
    db.insert(schema.articles)
      .values({ id: 1, name: "a", identifier: "i", date: seeded, feedId: 1, ...stamps })
      .run();

    // Every seeded row starts stale, so a passing assertion below can only
    // come from the update itself.
    expect(db.select().from(schema.users).get()?.updatedAt).toEqual(seeded);

    db.update(schema.users).set({ name: "changed" }).where(eq(schema.users.id, "u1")).run();
    db.update(schema.userSettings)
      .set({ theme: "dark" })
      .where(eq(schema.userSettings.userId, "u1"))
      .run();
    db.update(schema.feeds).set({ name: "changed" }).where(eq(schema.feeds.id, 1)).run();
    db.update(schema.tags).set({ name: "changed" }).where(eq(schema.tags.id, 1)).run();
    db.update(schema.articles).set({ read: true }).where(eq(schema.articles.id, 1)).run();

    expect(isAfterSeeded(db.select().from(schema.users).get()?.updatedAt)).toBe(true);
    expect(isAfterSeeded(db.select().from(schema.userSettings).get()?.updatedAt)).toBe(true);
    expect(isAfterSeeded(db.select().from(schema.feeds).get()?.updatedAt)).toBe(true);
    expect(isAfterSeeded(db.select().from(schema.tags).get()?.updatedAt)).toBe(true);
    expect(isAfterSeeded(db.select().from(schema.articles).get()?.updatedAt)).toBe(true);

    // createdAt is not auto_now: it must not have moved.
    expect(db.select().from(schema.users).get()?.createdAt).toEqual(seeded);
    connection.close();
  });
});
