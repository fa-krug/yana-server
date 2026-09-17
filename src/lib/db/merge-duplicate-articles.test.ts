import fs from "node:fs";
import path from "node:path";

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import * as schema from "./schema";
import { freshDatabase, MIGRATIONS_FOLDER } from "./test-support";

/**
 * `drizzle/0024_merge_duplicate_articles.sql` -- the one-shot cleanup for the
 * articles a feed had already stored twice before `articles.external_id` made
 * that impossible (see `@/lib/aggregators/external-id`).
 *
 * The schema comes from `freshDatabase()`, i.e. the real journal-driven
 * `applyMigrations()`, exactly as CLAUDE.md's testing convention requires. Only
 * the one data migration's statements are then replayed by hand, against rows
 * seeded to look like what the old handler wrote. That is not the hand-rolled
 * loader that rule warns about: nothing here derives a *schema* from the `.sql`
 * files, and replaying this file on an empty database (which is all it did when
 * the journal ran it) is a no-op, so the second application is the first one
 * with anything to do.
 *
 * What is being pinned is mostly what it must NOT do. A missed pair leaves a
 * duplicate the reader can delete; a wrong merge deletes an article nobody
 * knows is gone.
 */
const MERGE_SQL = fs.readFileSync(
  path.join(MIGRATIONS_FOLDER, "0024_merge_duplicate_articles.sql"),
  "utf-8",
);

describe("0024_merge_duplicate_articles", () => {
  let connection: ReturnType<typeof freshDatabase>;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  const seedFeed = (id: number) => {
    db.insert(schema.feeds)
      .values({ id, name: `Feed ${id}`, userId: "u1", identifier: "https://x.de/feed" })
      .run();
  };

  const seedArticle = (values: {
    id: number;
    feedId: number;
    name: string;
    identifier: string;
    read?: boolean;
    starred?: boolean;
  }) => {
    db.insert(schema.articles)
      .values({
        date: new Date("2026-09-04T05:10:01Z"),
        contentHash: `hash-${values.id}`,
        ...values,
      })
      .run();
    db.insert(schema.articleBlocks)
      .values({ articleId: values.id, position: 0, kind: "paragraph", text: `body ${values.id}` })
      .run();
  };

  const runMerge = () => {
    for (const statement of MERGE_SQL.split("--> statement-breakpoint")) {
      if (statement.trim()) connection.exec(statement);
    }
  };

  const remaining = () => db.select().from(schema.articles).orderBy(schema.articles.id).all();

  beforeEach(() => {
    connection = freshDatabase();
    db = drizzle(connection, { schema });
    db.insert(schema.users).values({ id: "u1", email: "u1@example.com" }).run();
  });

  it("merges one document served under two paths, keeping the oldest row", () => {
    seedFeed(1);
    seedArticle({
      id: 2588,
      feedId: 1,
      name: "Meloni stellt Regierungsrekord auf",
      identifier: "https://www.tagesschau.de/ausland/italien-meloni-124.html",
      read: true,
    });
    seedArticle({
      id: 2605,
      feedId: 1,
      name: "Meloni stellt Regierungsrekord auf",
      identifier: "https://www.tagesschau.de/ausland/europa/italien-meloni-124.html",
      starred: true,
    });

    runMerge();

    const rows = remaining();
    expect(rows).toHaveLength(1);
    // The oldest row survives: `createdAt` is the timeline's ordering key and
    // the sync cursor, and its id is what paired clients already hold.
    expect(rows[0].id).toBe(2588);
    // ...carrying the newest URL the feed was seen to use,
    expect(rows[0].identifier).toBe(
      "https://www.tagesschau.de/ausland/europa/italien-meloni-124.html",
    );
    // ...and neither reader-visible flag is lost in the merge.
    expect(rows[0].read).toBe(true);
    expect(rows[0].starred).toBe(true);
    // The hash still describes this row's own block tree -- nothing written
    // here is a fingerprint input -- so nulling it would buy a full rewrite,
    // and on an AI feed a paid request, to re-derive what is already correct.
    expect(rows[0].contentHash).toBe("hash-2588");
  });

  it("tombstones the row it deletes, and takes its block tree with it", () => {
    seedFeed(1);
    seedArticle({ id: 1, feedId: 1, name: "A", identifier: "https://x.de/one/a-1.html" });
    seedArticle({ id: 2, feedId: 1, name: "A", identifier: "https://x.de/two/a-1.html" });

    runMerge();

    // Without the tombstone a paired client keeps showing the duplicate
    // forever: /api/v1's sync `removed` list is the only way a deletion travels.
    const tombstones = db.select().from(schema.articleTombstones).all();
    expect(tombstones.map((t) => t.articleId)).toEqual([2]);
    expect(tombstones[0].userId).toBe("u1");
    expect(
      db.select().from(schema.articleBlocks).where(eq(schema.articleBlocks.articleId, 2)).all(),
    ).toHaveLength(0);
  });

  it("collapses a group of three to the oldest row", () => {
    seedFeed(1);
    seedArticle({ id: 1, feedId: 1, name: "T", identifier: "https://t.de/x/doc-1.html" });
    seedArticle({
      id: 2,
      feedId: 1,
      name: "T",
      identifier: "https://t.de/y/doc-1.html",
      read: true,
    });
    seedArticle({ id: 3, feedId: 1, name: "T", identifier: "https://t.de/z/doc-1.html" });

    runMerge();

    const rows = remaining();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(1);
    expect(rows[0].read).toBe(true);
    expect(rows[0].identifier).toBe("https://t.de/z/doc-1.html");
  });

  it("never merges across feeds", () => {
    // Two feeds carrying one article is a different situation with a different
    // answer: each feed owns its own copy, with its own options and tags.
    seedFeed(1);
    seedFeed(2);
    seedArticle({ id: 1, feedId: 1, name: "A", identifier: "https://x.de/a/doc-1.html" });
    seedArticle({ id: 2, feedId: 2, name: "A", identifier: "https://x.de/b/doc-1.html" });

    runMerge();

    expect(remaining()).toHaveLength(2);
  });

  it("never merges a recurring title whose documents differ", () => {
    // Tagesschau publishes several items titled just "tagesschau" a day.
    seedFeed(1);
    seedArticle({
      id: 1,
      feedId: 1,
      name: "tagesschau",
      identifier: "https://www.tagesschau.de/tagesschau_20_uhr/ts-80964.html",
    });
    seedArticle({
      id: 2,
      feedId: 1,
      name: "tagesschau",
      identifier: "https://www.tagesschau.de/tagesschau/ts-80922.html",
    });

    runMerge();

    expect(remaining()).toHaveLength(2);
  });

  it("never merges different articles that share a document name", () => {
    seedFeed(1);
    seedArticle({ id: 1, feedId: 1, name: "Story A", identifier: "https://x.de/a/index.html" });
    seedArticle({ id: 2, feedId: 1, name: "Story B", identifier: "https://x.de/b/index.html" });

    runMerge();

    expect(remaining()).toHaveLength(2);
  });

  it("never merges directory-style URLs, whose final segment is empty", () => {
    // A whole feed of these would otherwise collapse into a single row.
    seedFeed(1);
    seedArticle({ id: 1, feedId: 1, name: "Comic", identifier: "https://oglaf.com/a/" });
    seedArticle({ id: 2, feedId: 1, name: "Comic", identifier: "https://oglaf.com/b/" });

    runMerge();

    expect(remaining()).toHaveLength(2);
  });

  it("never merges query-string URLs, whose last '/' can sit inside the query", () => {
    seedFeed(1);
    seedArticle({ id: 1, feedId: 1, name: "P", identifier: "https://x.de/p?ref=/doc-1.html" });
    seedArticle({ id: 2, feedId: 1, name: "P", identifier: "https://x.de/q?ref=/doc-1.html" });

    runMerge();

    expect(remaining()).toHaveLength(2);
  });

  it("leaves a database with no duplicates completely untouched", () => {
    seedFeed(1);
    seedArticle({ id: 1, feedId: 1, name: "A", identifier: "https://x.de/a/doc-1.html" });
    seedArticle({ id: 2, feedId: 1, name: "B", identifier: "https://x.de/b/doc-2.html" });
    const before = remaining();

    runMerge();

    expect(remaining()).toEqual(before);
    expect(db.select().from(schema.articleTombstones).all()).toHaveLength(0);
  });
});
