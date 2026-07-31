import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { applyPragmas } from "./client";

function freshDb(): Database.Database {
  const connection = new Database(":memory:");
  applyPragmas(connection);
  const dir = path.resolve(import.meta.dirname, "../../../drizzle");
  for (const file of readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    // drizzle-kit separates statements with this marker.
    for (const statement of readFileSync(path.join(dir, file), "utf8").split(
      "--> statement-breakpoint",
    )) {
      if (statement.trim()) connection.exec(statement);
    }
  }
  return connection;
}

describe("migrations", () => {
  it("creates every expected table", () => {
    const connection = freshDb();
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
    connection.close();
  });

  it("reproduces every article index", () => {
    const connection = freshDb();
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

  it("does not constrain root-level block positions, which is why the writer must", () => {
    const connection = freshDb();
    connection.exec(`
      INSERT INTO users (id, email) VALUES ('u1', 'a@b.c');
      INSERT INTO feeds (name, user_id) VALUES ('f', 'u1');
    `);
    // Guard the documented SQLite NULL-distinctness behavior so nobody
    // "simplifies" the application-side check away.
    const insert = connection.prepare(
      "INSERT INTO article_blocks (article_id, parent_id, position, kind) VALUES (?, NULL, ?, ?)",
    );
    connection.exec(
      "INSERT INTO articles (name, identifier, date, feed_id) VALUES ('a', 'i', 0, 1)",
    );
    insert.run(1, 0, "paragraph");
    expect(() => insert.run(1, 0, "paragraph")).not.toThrow();
    connection.close();
  });
});
