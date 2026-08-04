import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { signInCookie } from "@/lib/auth/test-support";
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

describe("articles actions", () => {
  let dbPath: string;
  let actions: typeof import("./actions");
  let queries: typeof import("./queries");
  let auth: typeof import("@/lib/auth/server").auth;
  let createUserWithPassword: typeof import("@/lib/auth/server").createUserWithPassword;
  let client: typeof import("@/lib/db/client");
  let schema: typeof import("@/lib/db/schema");
  let actingUserId: string | undefined;

  function raw(db: unknown): Database.Database {
    return (db as { $client: Database.Database }).$client;
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
          name: "Original Name",
          identifier: `art-${Math.random()}`,
          date: new Date(1700000000000),
          feedId,
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
    dbPath = path.join(os.tmpdir(), `yana-art-actions-${stamp}.db`);
    applyMigrationsAt(dbPath);
    process.env.DATABASE_PATH = dbPath;
    process.env.BETTER_AUTH_SECRET = "test-secret-not-used-outside-this-file-0123456789";

    ({ auth, createUserWithPassword } = await import("@/lib/auth/server"));
    actions = await import("./actions");
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

  describe("updateArticle", () => {
    it("updates name, feedId, date but NOT createdAt", async () => {
      await currentUserId();
      const feed1 = seedFeed("Feed 1");
      const feed2 = seedFeed("Feed 2");
      const art = seedArticle(feed1);
      const originalCreatedAt = art.createdAt;

      const newDate = new Date(1710000000000);
      const res = await actions.updateArticle(art.id, {
        name: "New Name",
        feedId: feed2,
        date: newDate,
        createdAt: new Date(1800000000000), // Should be ignored by schema / action
      });

      expect(res.ok).toBe(true);

      const updated = await queries.getArticle(art.id);
      expect(updated?.name).toBe("New Name");
      expect(updated?.feedId).toBe(feed2);
      expect(updated?.date.getTime()).toBe(newDate.getTime());
      expect(updated?.createdAt.getTime()).toBe(originalCreatedAt.getTime());
    });

    it("rejects updating an article owned by another user", async () => {
      await currentUserId();
      const feedId = seedFeed();
      const art = seedArticle(feedId);

      await switchToOtherUser();
      const res = await actions.updateArticle(art.id, { name: "Hacked" });
      expect(res.ok).toBe(false);
      expect(res.error).toBe("Article not found");
    });

    it("rejects moving article to another user's feed", async () => {
      const user1Id = await currentUserId();
      const feed1 = seedFeed();
      const art = seedArticle(feed1);

      const otherUserId = await switchToOtherUser();
      const foreignFeed = seedFeed("Foreign Feed", otherUserId);

      // Back to owner
      const cookie = await signInCookie(auth, { email: "user@example.com", password: PASSWORD });
      requestAs(cookie);
      actingUserId = user1Id;

      const res = await actions.updateArticle(art.id, { feedId: foreignFeed });
      expect(res.ok).toBe(false);
      expect(res.error).toBe("Target feed not found or not owned");
    });
  });

  describe("deleteArticles", () => {
    it("deletes owner articles and skips foreign ones", async () => {
      const user1Id = await currentUserId();
      const feedId = seedFeed();
      const art1 = seedArticle(feedId);
      const art2 = seedArticle(feedId);

      await switchToOtherUser();
      const foreignFeed = seedFeed();
      const foreignArt = seedArticle(foreignFeed);

      // Back to user
      const cookie = await signInCookie(auth, { email: "user@example.com", password: PASSWORD });
      requestAs(cookie);
      actingUserId = user1Id;

      const res = await actions.deleteArticles([art1.id, art2.id, foreignArt.id]);
      expect(res.ok).toBe(true);
      expect(res.deleted).toBe(2);

      expect(await queries.getArticle(art1.id)).toBeNull();
      expect(await queries.getArticle(art2.id)).toBeNull();
    });
  });

  describe("setRead & setStarred", () => {
    it("bulk marks read and starred for owner articles", async () => {
      await currentUserId();
      const feedId = seedFeed();
      const art1 = seedArticle(feedId, { read: false, starred: false });
      const art2 = seedArticle(feedId, { read: false, starred: false });

      await actions.setRead([art1.id, art2.id], true);
      await actions.setStarred([art1.id], true);

      const u1 = await queries.getArticle(art1.id);
      const u2 = await queries.getArticle(art2.id);

      expect(u1?.read).toBe(true);
      expect(u1?.starred).toBe(true);
      expect(u2?.read).toBe(true);
      expect(u2?.starred).toBe(false);
    });
  });

  describe("reloadArticles", () => {
    it("groups the enqueued jobs into one run owned by the caller", async () => {
      const userId = await currentUserId();
      const feed = seedFeed("Feed");
      const a = seedArticle(feed);
      const b = seedArticle(feed);

      const result = await actions.reloadArticles([a.id, b.id]);
      expect(result.ok).toBe(true);
      expect(result.enqueued).toBe(2);

      const runRow = client
        .getDb()
        .select()
        .from(schema.runs)
        .all()
        .find((r) => r.id === result.runId)!;
      expect(runRow.userId).toBe(userId);
      expect(runRow.totalJobs).toBe(2);
      expect(runRow.status).toBe("running");

      const jobRows = client
        .getDb()
        .select()
        .from(schema.jobs)
        .all()
        .filter((j) => j.runId === result.runId);
      expect(jobRows).toHaveLength(2);
      expect(jobRows.every((j) => j.kind === "article.reload")).toBe(true);
      expect(jobRows.map((j) => j.payload)).toEqual([{ articleId: a.id }, { articleId: b.id }]);
    });

    it("filters out an article whose feed belongs to another user", async () => {
      const myId = await currentUserId();
      const myFeed = seedFeed("Mine", myId);
      const myArticle = seedArticle(myFeed);

      const otherId = await switchToOtherUser();
      const theirFeed = seedFeed("Theirs", otherId);
      const theirArticle = seedArticle(theirFeed);

      // Explicitly restore the original session rather than calling
      // currentUserId() again: switchToOtherUser() leaves actingUserId
      // pointing at the other user, so currentUserId()'s
      // `if (actingUserId) return actingUserId;` short-circuit would just
      // return the other user's id again instead of re-establishing "mine".
      const myCookie = await signInCookie(auth, { email: "user@example.com", password: PASSWORD });
      requestAs(myCookie);

      const result = await actions.reloadArticles([myArticle.id, theirArticle.id]);
      expect(result.enqueued).toBe(1);

      const jobRows = client
        .getDb()
        .select()
        .from(schema.jobs)
        .all()
        .filter((j) => j.runId === result.runId);
      expect(jobRows).toEqual([expect.objectContaining({ payload: { articleId: myArticle.id } })]);
    });

    it("returns an already-completed, zero-job run for an empty id list", async () => {
      await currentUserId();
      const result = await actions.reloadArticles([]);
      expect(result).toEqual({ ok: true, enqueued: 0, runId: expect.any(Number) });

      const runRow = client
        .getDb()
        .select()
        .from(schema.runs)
        .all()
        .find((r) => r.id === result.runId)!;
      expect(runRow.status).toBe("completed");
    });
  });
});
