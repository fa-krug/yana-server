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

describe("dashboard queries", () => {
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

  function requestAs(cookie: string): void {
    requestHeaders.current = new Headers({ cookie });
  }

  async function seedUser(input: { email: string; role?: string }): Promise<string> {
    const user = await createUserWithPassword({
      email: input.email,
      password: PASSWORD,
      firstName: "",
      lastName: "",
      role: input.role ?? "user",
    });
    return user.id;
  }

  async function signInAs(email: string): Promise<void> {
    const cookie = await signInCookie(auth, { email, password: PASSWORD });
    requestAs(cookie);
  }

  async function currentUserId(): Promise<string> {
    if (actingUserId) return actingUserId;
    actingUserId = await seedUser({ email: "user@example.com" });
    await signInAs("user@example.com");
    cookieJar.clear();
    return actingUserId;
  }

  async function switchToOtherUser(): Promise<string> {
    const otherId = await seedUser({ email: "other@example.com" });
    await signInAs("other@example.com");
    actingUserId = otherId;
    return otherId;
  }

  function seedFeed(overrides: Partial<typeof schema.feeds.$inferInsert> = {}, userId?: string) {
    const uid = userId ?? actingUserId!;
    return client.writeTransaction((tx) => {
      const feed = tx
        .insert(schema.feeds)
        .values({ name: "Test Feed", userId: uid, ...overrides })
        .returning()
        .get();
      return feed;
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
          ...overrides,
        })
        .returning()
        .get();
      return article;
    });
  }

  function seedTag(userId?: string) {
    const uid = userId ?? actingUserId!;
    return client.writeTransaction((tx) =>
      tx.insert(schema.tags).values({ name: "News", userId: uid }).returning().get(),
    );
  }

  beforeEach(async () => {
    vi.resetModules();
    requestHeaders.current = new Headers();
    cookieJar.clear();
    actingUserId = undefined;

    const stamp = `${process.pid}-${Math.random().toString(36).slice(2)}`;
    dbPath = path.join(os.tmpdir(), `yana-dashboard-queries-${stamp}.db`);
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

  describe("getDashboardStats", () => {
    it("scopes article, feed and tag counts to the current user", async () => {
      const userId = await currentUserId();
      const feed = seedFeed({ name: "Mine" });
      seedArticle(feed.id, { name: "Mine 1" });
      seedTag();

      await switchToOtherUser();
      const otherFeed = seedFeed({ name: "Theirs" });
      seedArticle(otherFeed.id, { name: "Theirs 1" });
      seedTag();

      await signInAs("user@example.com");
      actingUserId = userId;

      const stats = await queries.getDashboardStats();
      expect(stats.totalArticles).toBe(1);
      expect(stats.totalFeeds).toBe(1);
      expect(stats.tags).toBe(1);
    });

    it("counts unreadArticles as read = false, and totalArticles as both", async () => {
      await currentUserId();
      const feed = seedFeed();
      seedArticle(feed.id, { name: "Read", read: true });
      seedArticle(feed.id, { name: "Unread", read: false });

      const stats = await queries.getDashboardStats();
      expect(stats.totalArticles).toBe(2);
      expect(stats.unreadArticles).toBe(1);
    });

    it("counts enabledFeeds separately from totalFeeds", async () => {
      await currentUserId();
      seedFeed({ name: "Enabled", enabled: true });
      seedFeed({ name: "Disabled", enabled: false });

      const stats = await queries.getDashboardStats();
      expect(stats.totalFeeds).toBe(2);
      expect(stats.enabledFeeds).toBe(1);
    });
  });

  describe("getRecentUnreadArticles", () => {
    it("returns newest-first, respects the limit, and excludes other users", async () => {
      await currentUserId();
      const feed = seedFeed({ name: "My Feed" });
      seedArticle(feed.id, { name: "Oldest", date: new Date("2026-01-01") });
      seedArticle(feed.id, { name: "Middle", date: new Date("2026-01-02") });
      seedArticle(feed.id, { name: "Newest", date: new Date("2026-01-03") });
      seedArticle(feed.id, { name: "Read one is excluded", read: true, date: new Date() });

      await switchToOtherUser();
      const otherFeed = seedFeed({ name: "Other Feed" });
      seedArticle(otherFeed.id, { name: "Not mine", date: new Date("2026-01-04") });

      await signInAs("user@example.com");

      const result = await queries.getRecentUnreadArticles(2);
      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({ name: "Newest", feedName: "My Feed" });
      expect(result[1]).toMatchObject({ name: "Middle" });
    });

    it("returns an empty array for a user with nothing", async () => {
      await currentUserId();
      expect(await queries.getRecentUnreadArticles()).toEqual([]);
    });
  });
});
