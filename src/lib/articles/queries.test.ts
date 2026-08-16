import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { signInCookie } from "@/lib/auth/test-support";
import { parseListParams } from "@/lib/crud/params";
import { applyMigrationsAt } from "@/lib/db/test-support";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { requestHeaders, cookieJar } = vi.hoisted(() => ({
  requestHeaders: { current: new Headers() },
  cookieJar: new Map<string, string>(),
}));

vi.mock("next/headers", async () =>
  (await import("@/test/next-headers")).nextHeadersStub(requestHeaders, cookieJar),
);

const PASSWORD = "correct horse battery staple";

describe("articles queries", () => {
  let dbPath: string;
  let queries: typeof import("./queries");
  let auth: typeof import("@/lib/auth/server").auth;
  let createUserWithPassword: typeof import("@/lib/auth/server").createUserWithPassword;
  let client: typeof import("@/lib/db/client");
  let schema: typeof import("@/lib/db/schema");
  let actingUserId: string | undefined;

  function raw(db: unknown): Database.Database {
    return (db as { $client: Database.Database }).$client;
  }

  /** Rows the FTS index itself matches, bypassing the join in listArticles. */
  function ftsMatchCount(connection: Database.Database, term: string): number {
    const row = connection
      .prepare("SELECT count(*) AS n FROM articles_fts WHERE articles_fts MATCH ?")
      .get(`"${term}"`) as { n: number };
    return row.n;
  }

  /**
   * A summary of the FTS index's own storage (`articles_fts_data` is FTS5's
   * shadow table). Any write to the index changes it, so an unchanged value is
   * evidence that no reindex happened -- which nothing observable through
   * `articles_fts` itself can show, since a delete-and-reinsert of the same
   * content leaves the same rows matchable.
   */
  function ftsIndexFingerprint(connection: Database.Database): string {
    const row = connection
      .prepare(
        "SELECT count(*) AS n, coalesce(sum(length(block)), 0) AS bytes FROM articles_fts_data",
      )
      .get() as { n: number; bytes: number };
    return `${row.n}:${row.bytes}`;
  }

  function requestAs(cookie: string): void {
    requestHeaders.current = new Headers({ cookie });
  }

  async function seedUser(input: { email: string }): Promise<string> {
    const user = await createUserWithPassword({
      email: input.email,
      password: PASSWORD,
      firstName: "",
      lastName: "",
      role: "user",
    });
    return user.id;
  }

  async function currentUserId(): Promise<string> {
    if (actingUserId) return actingUserId;
    actingUserId = await seedUser({ email: "user@example.com" });
    const cookie = await signInCookie(auth, { email: "user@example.com", password: PASSWORD });
    requestAs(cookie);
    cookieJar.clear();
    return actingUserId;
  }

  async function switchToOtherUser(): Promise<string> {
    const otherId = await seedUser({ email: "other@example.com" });
    const cookie = await signInCookie(auth, { email: "other@example.com", password: PASSWORD });
    requestAs(cookie);
    actingUserId = otherId;
    return otherId;
  }

  function seedFeed(name = "Test Feed", userId?: string): number {
    const uid = userId ?? actingUserId!;
    return client.writeTransaction((tx) => {
      const feed = tx
        .insert(schema.feeds)
        .values({ name, userId: uid })
        .returning({ id: schema.feeds.id })
        .get();
      return feed.id;
    });
  }

  function seedArticle(
    feedId: number,
    overrides: Partial<typeof schema.articles.$inferInsert> = {},
  ) {
    return client.writeTransaction((tx) => {
      const article = tx
        .insert(schema.articles)
        .values({
          name: "Article Title",
          identifier: `art-${Math.random()}`,
          date: new Date(),
          feedId,
          plainText: "Full plain text body content",
          rawContent: "<p>Full plain text body content</p>",
          ...overrides,
        })
        .returning()
        .get();
      return article;
    });
  }

  beforeEach(async () => {
    vi.resetModules();
    requestHeaders.current = new Headers();
    cookieJar.clear();
    actingUserId = undefined;

    const stamp = `${process.pid}-${Math.random().toString(36).slice(2)}`;
    dbPath = path.join(os.tmpdir(), `yana-art-queries-${stamp}.db`);
    applyMigrationsAt(dbPath);
    process.env.DATABASE_PATH = dbPath;
    process.env.BETTER_AUTH_SECRET = "test-secret-not-used-outside-this-file-0123456789";

    ({ auth, createUserWithPassword } = await import("@/lib/auth/server"));
    queries = await import("./queries");
    client = await import("@/lib/db/client");
    schema = await import("@/lib/db/schema");
  });

  afterEach(() => {
    delete process.env.DATABASE_PATH;
    delete process.env.BETTER_AUTH_SECRET;
    const connection = raw(client.getDb());
    if (connection.open) connection.close();
    for (const suffix of ["", "-shm", "-wal"]) {
      fs.rmSync(`${dbPath}${suffix}`, { force: true });
    }
  });

  describe("listArticles", () => {
    it("returns owner-scoped articles with explicit column selection", async () => {
      const user1Id = await currentUserId();
      const feedId = seedFeed("Tech Blog");
      seedArticle(feedId, { name: "First Post" });

      await switchToOtherUser();
      const otherFeed = seedFeed("Other Blog");
      seedArticle(otherFeed, { name: "Other Post" });

      // Back to original user
      const cookie = await signInCookie(auth, { email: "user@example.com", password: PASSWORD });
      requestAs(cookie);
      actingUserId = user1Id;

      const params = parseListParams({});
      const result = await queries.listArticles(params);

      expect(result.total).toBe(1);
      expect(result.rows[0]).toMatchObject({
        name: "First Post",
        feedName: "Tech Blog",
        feedId,
      });
      // Verify plainText and rawContent are omitted from row
      expect(result.rows[0]).not.toHaveProperty("plainText");
      expect(result.rows[0]).not.toHaveProperty("rawContent");
    });

    it("searches name and plainText", async () => {
      await currentUserId();
      const feedId = seedFeed();
      seedArticle(feedId, { name: "TypeScript Tips", plainText: "something else" });
      seedArticle(feedId, { name: "Unrelated Title", plainText: "drizzle ORM guide" });

      const nameMatch = await queries.listArticles(parseListParams({ q: "TypeScript" }));
      expect(nameMatch.total).toBe(1);
      expect(nameMatch.rows[0].name).toBe("TypeScript Tips");

      const bodyMatch = await queries.listArticles(parseListParams({ q: "drizzle" }));
      expect(bodyMatch.total).toBe(1);
      expect(bodyMatch.rows[0].name).toBe("Unrelated Title");
    });

    it("finds an article by a word in its body via the FTS index", async () => {
      await currentUserId();
      const feedId = seedFeed();
      seedArticle(feedId, { name: "Matching", plainText: "a guide to kubernetes operators" });
      seedArticle(feedId, { name: "Other", plainText: "an unrelated body" });

      const result = await queries.listArticles(parseListParams({ q: "kubernetes" }));
      expect(result.rows.map((r) => r.name)).toEqual(["Matching"]);
      expect(result.total).toBe(1);
    });

    it("finds an article by a prefix of the last search token", async () => {
      await currentUserId();
      const feedId = seedFeed();
      seedArticle(feedId, { name: "Matching", plainText: "a guide to kubernetes operators" });

      // Only the last token carries the `*`, so this is a prefix match on a whole
      // token -- not the mid-word match the old LIKE '%term%' would have given.
      const result = await queries.listArticles(parseListParams({ q: "kuber" }));
      expect(result.rows.map((r) => r.name)).toEqual(["Matching"]);
    });

    it("does not match a fragment from the middle of a word", async () => {
      await currentUserId();
      const feedId = seedFeed();
      seedArticle(feedId, { name: "Matching", plainText: "a guide to kubernetes operators" });

      // The documented behaviour change from LIKE '%term%'. Pinned so it is a
      // decision on record rather than a surprise.
      const result = await queries.listArticles(parseListParams({ q: "bernetes" }));
      expect(result.rows).toHaveLength(0);
    });

    it("keeps the FTS index current when an article's text is updated", async () => {
      await currentUserId();
      const feedId = seedFeed();
      const article = seedArticle(feedId, { name: "Matching", plainText: "kubernetes guide" });

      client.writeTransaction((tx) => {
        tx.update(schema.articles)
          .set({ plainText: "helm guide" })
          .where(eq(schema.articles.id, article.id))
          .run();
      });

      // Proves the AFTER UPDATE trigger fires -- both halves of it: the new word
      // is found and the old one is gone.
      expect((await queries.listArticles(parseListParams({ q: "helm" }))).rows).toHaveLength(1);
      expect((await queries.listArticles(parseListParams({ q: "kubernetes" }))).rows).toHaveLength(
        0,
      );
    });

    it("drops an article out of the index when it is deleted", async () => {
      await currentUserId();
      const feedId = seedFeed();
      const article = seedArticle(feedId, { name: "Matching", plainText: "kubernetes guide" });

      client.writeTransaction((tx) => {
        tx.delete(schema.articles).where(eq(schema.articles.id, article.id)).run();
      });

      // Asserted against the index itself, not through listArticles: that query
      // joins real `articles` rows, so a dangling FTS entry could not produce a
      // row either way and the assertion would hold with no DELETE trigger at
      // all. These two do fail without it -- the orphaned entry is still
      // matchable, and integrity-check reports the index disagreeing with the
      // content table.
      const connection = raw(client.getDb());
      expect(ftsMatchCount(connection, "kubernetes")).toBe(0);
      expect(() =>
        connection
          .prepare("INSERT INTO articles_fts(articles_fts) VALUES('integrity-check')")
          .run(),
      ).not.toThrow();
    });

    it("does not reindex an article when only a non-indexed column is written", async () => {
      await currentUserId();
      const feedId = seedFeed();
      const article = seedArticle(feedId, { name: "Matching", plainText: "kubernetes guide" });
      const connection = raw(client.getDb());
      const before = ftsIndexFingerprint(connection);

      // `read`/`starred` flips (bulk "mark all read" writes thousands at a
      // time) and the aggregate handler's separate `contentHash` write are the
      // two paths that would otherwise re-tokenize a whole body for nothing.
      // Without the AFTER UPDATE trigger's WHEN guard each of these writes a
      // 'delete' plus a reinsert into the index; with it, the index is not
      // touched at all, which is what the shadow table proves.
      client.writeTransaction((tx) => {
        tx.update(schema.articles)
          .set({ read: true })
          .where(eq(schema.articles.id, article.id))
          .run();
      });
      expect(ftsIndexFingerprint(connection)).toBe(before);

      client.writeTransaction((tx) => {
        tx.update(schema.articles)
          .set({ contentHash: null })
          .where(eq(schema.articles.id, article.id))
          .run();
      });
      expect(ftsIndexFingerprint(connection)).toBe(before);

      // ...while a write that does touch the body still reindexes, so the guard
      // cannot be satisfied by a trigger that never fires at all.
      client.writeTransaction((tx) => {
        tx.update(schema.articles)
          .set({ plainText: "kubernetes handbook" })
          .where(eq(schema.articles.id, article.id))
          .run();
      });
      expect(ftsIndexFingerprint(connection)).not.toBe(before);
      expect(ftsMatchCount(connection, "handbook")).toBe(1);
      expect(ftsMatchCount(connection, "guide")).toBe(0);
    });

    it("keeps an article searchable after a read flip", async () => {
      await currentUserId();
      const feedId = seedFeed();
      const article = seedArticle(feedId, { name: "Matching", plainText: "kubernetes guide" });

      client.writeTransaction((tx) => {
        tx.update(schema.articles)
          .set({ read: true })
          .where(eq(schema.articles.id, article.id))
          .run();
      });

      const result = await queries.listArticles(parseListParams({ q: "kubernetes" }));
      expect(result.rows.map((r) => r.name)).toEqual(["Matching"]);
    });

    it("treats a search string made of FTS operators as text, not syntax", async () => {
      await currentUserId();
      const feedId = seedFeed();
      seedArticle(feedId, { name: "Matching", plainText: "kubernetes guide" });

      // Unquoted, every one of these is FTS5 syntax and the query would throw.
      // A search box could never produce an error with LIKE and must not now.
      for (const q of ["NOT OR *", 'name:"', "^foo", "AND"]) {
        const result = await queries.listArticles(parseListParams({ q }));
        expect(result.rows).toHaveLength(0);
      }
    });

    it("never matches an article belonging to another user", async () => {
      await currentUserId();
      const feedId = seedFeed();
      seedArticle(feedId, { name: "Matching", plainText: "kubernetes guide" });

      await switchToOtherUser();

      // The FTS table is not user-scoped -- ownership still comes from the
      // feeds.userId join. This pins that the MATCH did not bypass it.
      const result = await queries.listArticles(parseListParams({ q: "kubernetes" }));
      expect(result.rows).toHaveLength(0);
    });

    it("filters by read, starred, feed, and tag", async () => {
      await currentUserId();
      const feed1 = seedFeed("Feed 1");
      const feed2 = seedFeed("Feed 2");

      const tagId = client.writeTransaction((tx) => {
        const tag = tx
          .insert(schema.tags)
          .values({ name: "News", userId: actingUserId! })
          .returning()
          .get();
        tx.insert(schema.feedTags).values({ feedId: feed1, tagId: tag.id }).run();
        return tag.id;
      });

      seedArticle(feed1, { name: "Read & Starred", read: true, starred: true });
      seedArticle(feed2, { name: "Unread & Unstarred", read: false, starred: false });

      const readRes = await queries.listArticles(parseListParams({ read: "true" }));
      expect(readRes.total).toBe(1);
      expect(readRes.rows[0].name).toBe("Read & Starred");

      const starredRes = await queries.listArticles(parseListParams({ starred: "true" }));
      expect(starredRes.total).toBe(1);
      expect(starredRes.rows[0].name).toBe("Read & Starred");

      const feedRes = await queries.listArticles(parseListParams({ feed: String(feed1) }));
      expect(feedRes.total).toBe(1);

      const tagRes = await queries.listArticles(parseListParams({ tag: String(tagId) }));
      expect(tagRes.total).toBe(1);
      expect(tagRes.rows[0].feedId).toBe(feed1);
    });
  });

  describe("getArticle", () => {
    it("returns article with feed details for owner", async () => {
      await currentUserId();
      const feedId = seedFeed("Awesome Feed");
      const art = seedArticle(feedId, { name: "Article Details" });

      const result = await queries.getArticle(art.id);
      expect(result).not.toBeNull();
      expect(result?.name).toBe("Article Details");
      expect(result?.feed).toMatchObject({ id: feedId, name: "Awesome Feed" });
    });

    it("returns null for another user's article", async () => {
      await currentUserId();
      const feedId = seedFeed();
      const art = seedArticle(feedId);

      await switchToOtherUser();
      expect(await queries.getArticle(art.id)).toBeNull();
    });
  });

  describe("getBlockTree", () => {
    it("fetches blocks and runs and builds tree", async () => {
      await currentUserId();
      const feedId = seedFeed();
      const art = seedArticle(feedId);

      client.writeTransaction((tx) => {
        const blk = tx
          .insert(schema.articleBlocks)
          .values({ articleId: art.id, position: 0, kind: "paragraph" })
          .returning()
          .get();
        tx.insert(schema.articleInlineRuns)
          .values({ blockId: blk.id, position: 0, text: "Hello block" })
          .run();
      });

      const tree = await queries.getBlockTree(art.id);
      expect(tree).toHaveLength(1);
      expect(tree[0].kind).toBe("paragraph");
      expect(tree[0].runs[0].text).toBe("Hello block");
    });

    it("returns empty array for unauthorized article", async () => {
      await currentUserId();
      const feedId = seedFeed();
      const art = seedArticle(feedId);

      await switchToOtherUser();
      expect(await queries.getBlockTree(art.id)).toEqual([]);
    });
  });
});
