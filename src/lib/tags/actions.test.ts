import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { signInCookie } from "@/lib/auth/test-support";
import { applyMigrationsAt } from "@/lib/db/test-support";
import { DEFAULT_TAG_COLOR } from "@/lib/tags/colors";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { requestHeaders, cookieJar } = vi.hoisted(() => ({
  requestHeaders: { current: new Headers() },
  cookieJar: new Map<string, string>(),
}));

vi.mock("next/headers", async () =>
  (await import("@/test/next-headers")).nextHeadersStub(requestHeaders, cookieJar),
);

const PASSWORD = "correct horse battery staple";

describe("the tags queries and actions", () => {
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

  async function switchToOtherUser(): Promise<void> {
    await seedUser({ email: "other@example.com" });
    const cookie = await signInCookie(auth, { email: "other@example.com", password: PASSWORD });
    requestAs(cookie);
    actingUserId = undefined; // Not tracked for currentUserId() since this is "other"
  }

  function seedFeedWithTag(tagId: number): number {
    return client.writeTransaction((tx) => {
      const feed = tx
        .insert(schema.feeds)
        .values({ name: "My Feed", userId: actingUserId! })
        .returning({ id: schema.feeds.id })
        .get();
      tx.insert(schema.feedTags).values({ feedId: feed.id, tagId }).run();
      return feed.id;
    });
  }

  function feedExists(id: number): boolean {
    const connection = new Database(dbPath);
    try {
      const row = connection.prepare("SELECT 1 FROM feeds WHERE id = ?").get(id);
      return !!row;
    } finally {
      connection.close();
    }
  }

  function feedTagCount(feedId: number): number {
    const connection = new Database(dbPath);
    try {
      const row = connection
        .prepare("SELECT COUNT(*) as count FROM feed_tags WHERE feed_id = ?")
        .get(feedId) as { count: number };
      return row.count;
    } finally {
      connection.close();
    }
  }

  beforeEach(async () => {
    vi.resetModules();
    requestHeaders.current = new Headers();
    cookieJar.clear();
    actingUserId = undefined;

    const stamp = `${process.pid}-${Math.random().toString(36).slice(2)}`;
    dbPath = path.join(os.tmpdir(), `yana-tags-${stamp}.db`);
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

  describe("createTag", () => {
    it("rejects a duplicate name for the same user as a field error", async () => {
      await currentUserId();
      await actions.createTag({ name: "News" });
      const result = await actions.createTag({ name: "News" });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errorKey).toBe("nameTaken");
    });

    it("treats differing case and surrounding space as the same name", async () => {
      await currentUserId();
      await actions.createTag({ name: "Tech" });
      const result = await actions.createTag({ name: "  tech " });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errorKey).toBe("nameTaken");
    });

    it("rejects an empty name", async () => {
      await currentUserId();
      const result = await actions.createTag({ name: "   " });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errorKey).toBe("saveFailed");
    });

    it("allows the same name for a different user", async () => {
      await currentUserId();
      await actions.createTag({ name: "Shared" });
      await switchToOtherUser();
      expect((await actions.createTag({ name: "Shared" })).ok).toBe(true);
    });

    it("stores the given color", async () => {
      await currentUserId();
      const result = (await actions.createTag({ name: "News", color: "violet" })) as { id: number };
      expect((await queries.getTag(result.id))?.color).toBe("violet");
    });

    it("defaults to the standard color when none is given", async () => {
      await currentUserId();
      const result = (await actions.createTag({ name: "News" })) as { id: number };
      expect((await queries.getTag(result.id))?.color).toBe(DEFAULT_TAG_COLOR);
    });

    it("rejects an unrecognized color", async () => {
      await currentUserId();
      const result = await actions.createTag({ name: "News", color: "mauve" });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errorKey).toBe("saveFailed");
    });
  });

  describe("getTag", () => {
    it("returns null for another user's tag", async () => {
      await currentUserId();
      const { id } = (await actions.createTag({ name: "Mine" })) as { id: number };
      await switchToOtherUser();
      expect(await queries.getTag(id)).toBeNull();
    });
  });

  describe("deleteTags", () => {
    it("detaches feeds without deleting them", async () => {
      await currentUserId();
      const { id } = (await actions.createTag({ name: "Temp" })) as { id: number };
      const feedId = seedFeedWithTag(id);
      await actions.deleteTags([id]);
      expect(feedExists(feedId)).toBe(true);
      expect(feedTagCount(feedId)).toBe(0);
    });

    it("refuses another user's tag", async () => {
      await currentUserId();
      const { id } = (await actions.createTag({ name: "Mine" })) as { id: number };
      await switchToOtherUser();
      const result = await actions.deleteTags([id]);
      if (result.ok) expect(result.deleted).toBe(0);
    });
  });

  describe("updateTag", () => {
    it("allows renaming a tag to its own current name", async () => {
      await currentUserId();
      const { id } = (await actions.createTag({ name: "Keep" })) as { id: number };
      expect((await actions.updateTag(id, { name: "Keep" })).ok).toBe(true);
    });

    it("changes the color when one is given", async () => {
      await currentUserId();
      const { id } = (await actions.createTag({ name: "Keep" })) as { id: number };
      await actions.updateTag(id, { name: "Keep", color: "teal" });
      expect((await queries.getTag(id))?.color).toBe("teal");
    });

    it("leaves the color untouched when none is given", async () => {
      await currentUserId();
      const { id } = (await actions.createTag({ name: "Keep", color: "pink" })) as { id: number };
      await actions.updateTag(id, { name: "Renamed" });
      expect((await queries.getTag(id))?.color).toBe("pink");
    });
  });
});
