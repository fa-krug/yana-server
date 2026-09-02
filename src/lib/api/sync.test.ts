import { eq } from "drizzle-orm";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyMigrationsAt } from "@/lib/db/test-support";

describe("sync", () => {
  let dbPath: string;
  let client: typeof import("@/lib/db/client");
  let schema: typeof import("@/lib/db/schema");
  let sync: typeof import("./sync");
  let userId: string;
  let feedId: number;

  beforeEach(async () => {
    const stamp = `${process.pid}-${Math.random().toString(36).slice(2)}`;
    dbPath = path.join(os.tmpdir(), `yana-sync-${stamp}.db`);
    applyMigrationsAt(dbPath);
    // `@/lib/db/client` memoizes both DB_PATH and the getDb() connection at
    // module-load time -- without resetting the module registry here, every
    // test after the first would keep talking to the *first* test's
    // database (or, worse, whatever process.env.DATABASE_PATH resolved to
    // before this file's first import, e.g. the real dev data/yana.db).
    // See src/lib/feeds/actions.test.ts for the same pattern.
    vi.resetModules();
    process.env.DATABASE_PATH = dbPath;

    client = await import("@/lib/db/client");
    schema = await import("@/lib/db/schema");
    sync = await import("./sync");

    const { createUserWithPassword } = await import("@/lib/auth/server");
    process.env.BETTER_AUTH_SECRET = "test-secret-not-used-outside-this-file-0123456789";
    const user = await createUserWithPassword({
      email: "a@example.com",
      password: "correct horse battery staple",
    });
    userId = user.id;

    const feed = client.writeTransaction((tx) =>
      tx
        .insert(schema.feeds)
        .values({ name: "F", aggregator: "full_website", identifier: "https://x.example", userId })
        .returning({ id: schema.feeds.id })
        .get(),
    );
    feedId = feed.id;
  });

  afterEach(() => {
    delete process.env.DATABASE_PATH;
    fs.rmSync(dbPath, { force: true });
  });

  it("returns everything as `new` on the zero cursor", () => {
    client.writeTransaction((tx) =>
      tx
        .insert(schema.articles)
        .values({ name: "A1", identifier: "a1", date: new Date(), feedId })
        .run(),
    );

    const page = sync.syncArticles(userId, sync.ZERO_CURSOR, 100);
    expect("resyncRequired" in page).toBe(false);
    if ("resyncRequired" in page) throw new Error("unreachable");
    expect(page.new).toHaveLength(1);
    expect(page.updated).toHaveLength(0);
    expect(page.removed).toHaveLength(0);
  });

  it("a second call with the returned cursor sees nothing new", () => {
    client.writeTransaction((tx) =>
      tx
        .insert(schema.articles)
        .values({ name: "A1", identifier: "a1", date: new Date(), feedId })
        .run(),
    );
    const first = sync.syncArticles(userId, sync.ZERO_CURSOR, 100);
    if ("resyncRequired" in first) throw new Error("unreachable");

    const second = sync.syncArticles(userId, sync.decodeCursor(first.nextCursor), 100);
    if ("resyncRequired" in second) throw new Error("unreachable");
    expect(second.new).toHaveLength(0);
    expect(second.updated).toHaveLength(0);
  });

  it("surfaces a starred toggle as an update, not a duplicate new", () => {
    // createdAt/updatedAt are stored at whole-second precision (see the
    // tie-break comment in src/lib/api/sync.ts), and the tie-break for
    // "already delivered" uses this row's own id -- so a second write to the
    // *same* row within the *same* wall-clock second as the first is
    // genuinely indistinguishable from "unchanged" at this granularity. Back
    // the insert up by a few seconds so the later `starred` write (stamped
    // with a real `new Date()` via $onUpdate) reliably lands in a later
    // second, rather than depending on this test happening to straddle a
    // second boundary on its own.
    const past = new Date(Date.now() - 5000);
    const inserted = client.writeTransaction((tx) =>
      tx
        .insert(schema.articles)
        .values({
          name: "A1",
          identifier: "a1",
          date: new Date(),
          feedId,
          createdAt: past,
          updatedAt: past,
        })
        .returning({ id: schema.articles.id })
        .get(),
    );
    const first = sync.syncArticles(userId, sync.ZERO_CURSOR, 100);
    if ("resyncRequired" in first) throw new Error("unreachable");

    client.writeTransaction((tx) =>
      tx
        .update(schema.articles)
        .set({ starred: true })
        .where(eq(schema.articles.id, inserted.id))
        .run(),
    );

    const second = sync.syncArticles(userId, sync.decodeCursor(first.nextCursor), 100);
    if ("resyncRequired" in second) throw new Error("unreachable");
    expect(second.new).toHaveLength(0);
    expect(second.updated).toHaveLength(1);
    expect(second.updated[0].starred).toBe(true);
  });

  it("surfaces a hard delete as a removed id", () => {
    const inserted = client.writeTransaction((tx) =>
      tx
        .insert(schema.articles)
        .values({ name: "A1", identifier: "a1", date: new Date(), feedId })
        .returning({ id: schema.articles.id })
        .get(),
    );
    const first = sync.syncArticles(userId, sync.ZERO_CURSOR, 100);
    if ("resyncRequired" in first) throw new Error("unreachable");

    client.writeTransaction((tx) => {
      tx.insert(schema.articleTombstones).values({ articleId: inserted.id, userId }).run();
      tx.delete(schema.articles).where(eq(schema.articles.id, inserted.id)).run();
    });

    const second = sync.syncArticles(userId, sync.decodeCursor(first.nextCursor), 100);
    if ("resyncRequired" in second) throw new Error("unreachable");
    expect(second.removed).toEqual([inserted.id]);
  });

  it("requires a resync when the cursor predates a pruned tombstone", () => {
    // Direct test of cursorExpired()'s actual condition: a cursor whose
    // removedPos is non-zero (i.e. some earlier tombstone WAS already
    // consumed) but old, constructed directly via encodeCursor rather than
    // derived from a real prior call -- simulating that the tombstone this
    // cursor points at has since been pruned. A *newer* tombstone still
    // surviving in the table (deletedAt after the cursor's claimed position)
    // is then exactly "a deletion between then and now may already have
    // been pruned and can no longer be proven complete."
    //
    // removedPos must be non-zero: [0, 0] means "never consumed a
    // tombstone," which is a fresh backfill with nothing to lose track of,
    // never resync-worthy -- see the comment on cursorExpired() itself.
    const staleCursor = sync.encodeCursor({
      newPos: [0, 0],
      updatedPos: [0, 0],
      removedPos: [Math.floor(Date.now() / 1000) - 80 * 24 * 60 * 60, 1],
    });

    client.writeTransaction((tx) =>
      tx
        .insert(schema.articleTombstones)
        .values({
          articleId: 998,
          userId,
          deletedAt: new Date(Date.now() - 50 * 24 * 60 * 60_000), // newer than staleCursor's removedPos
        })
        .run(),
    );

    const result = sync.syncArticles(userId, sync.decodeCursor(staleCursor), 100);
    expect("resyncRequired" in result).toBe(true);
  });

  it("requires a resync when every tombstone has been pruned and the cursor predates the retention horizon", async () => {
    // The gap finding 3 of the whole-branch review closed: with zero
    // surviving tombstone rows, the old logic found no "oldest" row and
    // defaulted to `false` -- "not expired" -- even though a cursor this old
    // could easily have missed deletions that happened and were later
    // pruned by the retention job (RETENTION_TOMBSTONE_DAYS = 90). The fix
    // compares the cursor against the prune horizon itself, which does not
    // depend on any row surviving to compare against.
    const { RETENTION_TOMBSTONE_DAYS } = await import("@/lib/jobs/handlers/retention");
    const staleCursor = sync.encodeCursor({
      newPos: [0, 0],
      updatedPos: [0, 0],
      removedPos: [
        Math.floor(Date.now() / 1000) - (RETENTION_TOMBSTONE_DAYS + 10) * 24 * 60 * 60,
        1,
      ],
    });

    // No tombstone rows at all -- as if the retention job pruned every one.
    const result = sync.syncArticles(userId, sync.decodeCursor(staleCursor), 100);

    expect(result).toEqual({ resyncRequired: true });
  });

  it("does not require a resync on the zero cursor even when tombstones already exist", () => {
    // The literal condition ("removedPos predates the oldest surviving
    // tombstone") would be true for ANY tombstone once a fresh ZERO_CURSOR
    // client asks, since [0,0] predates every real timestamp. That would
    // force every brand-new client through a pointless extra round trip on
    // its very first call. ZERO_CURSOR must never be treated as expired.
    client.writeTransaction((tx) =>
      tx.insert(schema.articleTombstones).values({ articleId: 997, userId }).run(),
    );

    const result = sync.syncArticles(userId, sync.ZERO_CURSOR, 100);
    expect("resyncRequired" in result).toBe(false);
  });

  it("does not crash and returns empty pages for a user with zero feeds", async () => {
    const { createUserWithPassword } = await import("@/lib/auth/server");
    const feedlessUser = await createUserWithPassword({
      email: "feedless@example.com",
      password: "correct horse battery staple",
    });

    const page = sync.syncArticles(feedlessUser.id, sync.ZERO_CURSOR, 100);
    expect("resyncRequired" in page).toBe(false);
    if ("resyncRequired" in page) throw new Error("unreachable");
    expect(page.new).toHaveLength(0);
    expect(page.updated).toHaveLength(0);
    expect(page.removed).toHaveLength(0);
  });

  it("decodeCursor never throws on garbage input", () => {
    expect(sync.decodeCursor(undefined)).toEqual(sync.ZERO_CURSOR);
    expect(sync.decodeCursor(null)).toEqual(sync.ZERO_CURSOR);
    expect(sync.decodeCursor("")).toEqual(sync.ZERO_CURSOR);
    // Not valid base64url at all.
    expect(sync.decodeCursor("!!!not-base64!!!")).toEqual(sync.ZERO_CURSOR);
    // Valid base64url, but decodes to garbage, non-JSON bytes.
    expect(sync.decodeCursor(Buffer.from("not json at all").toString("base64url"))).toEqual(
      sync.ZERO_CURSOR,
    );
    // Valid base64url, valid JSON, but the wrong shape entirely.
    expect(
      sync.decodeCursor(Buffer.from(JSON.stringify({ foo: "bar" })).toString("base64url")),
    ).toEqual(sync.ZERO_CURSOR);
    // Valid JSON, right key names, wrong value types.
    expect(
      sync.decodeCursor(
        Buffer.from(
          JSON.stringify({ newPos: "nope", updatedPos: [0, 0], removedPos: [0, 0] }),
        ).toString("base64url"),
      ),
    ).toEqual(sync.ZERO_CURSOR);
    // A well-formed cursor still round-trips.
    const real = sync.encodeCursor({ newPos: [1, 2], updatedPos: [3, 4], removedPos: [5, 6] });
    expect(sync.decodeCursor(real)).toEqual({
      newPos: [1, 2],
      updatedPos: [3, 4],
      removedPos: [5, 6],
    });
  });

  it("selects only the columns the wire format uses", () => {
    // A bare `db.select()` would pull `plainText` -- the largest column on
    // the table -- off disk for every row in both the `new` and `updated`
    // streams, only for the serializer to discard it.
    // Spy on what the database is actually asked for, rather than asserting
    // on the serializer's output, which would pass even with a bare select.
    client.writeTransaction((tx) =>
      tx
        .insert(schema.articles)
        .values({ name: "A1", identifier: "a1", date: new Date(), feedId })
        .run(),
    );

    const db = client.getDb() as unknown as { $client: { prepare: (sql: string) => unknown } };
    const seen: string[] = [];
    const original = db.$client.prepare.bind(db.$client);
    db.$client.prepare = (sql: string) => {
      seen.push(sql);
      return original(sql);
    };

    try {
      sync.syncArticles(userId, sync.ZERO_CURSOR, 10);
    } finally {
      db.$client.prepare = original;
    }

    const articleSelects = seen.filter((sql) => /from "articles"/i.test(sql));
    expect(articleSelects.length).toBeGreaterThan(0);
    for (const sql of articleSelects) {
      expect(sql).not.toMatch(/"raw_content"/);
      expect(sql).not.toMatch(/"plain_text"/);
    }
  });

  it("does not duplicate an article that is both new and updated within the same sync window", () => {
    client.writeTransaction((tx) =>
      tx
        .insert(schema.articles)
        .values({ name: "A1", identifier: "a1", date: new Date(), feedId })
        .run(),
    );

    // No prior sync call happened -- from the ZERO_CURSOR's perspective, this
    // article is both newly created *and* has a fresh updatedAt (both default
    // to now on insert). It must land in `new` only.
    const page = sync.syncArticles(userId, sync.ZERO_CURSOR, 100);
    if ("resyncRequired" in page) throw new Error("unreachable");
    expect(page.new).toHaveLength(1);
    expect(page.updated).toHaveLength(0);
  });
});
