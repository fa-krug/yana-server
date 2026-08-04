import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { vi } from "vitest";

import { applyMigrationsAt } from "@/lib/db/test-support";

vi.mock("next/server", () => import("@/test/next-server"));

describe("GET /api/v1/feeds", () => {
  let dbPath: string;
  let GET: typeof import("./route").GET;
  let createUserWithPassword: typeof import("@/lib/auth/server").createUserWithPassword;
  let createDeviceSession: typeof import("@/lib/auth/server").createDeviceSession;
  let client: typeof import("@/lib/db/client");
  let schema: typeof import("@/lib/db/schema");

  beforeEach(async () => {
    // A fresh module registry per test: `getDb()` is a lazy module-level
    // singleton (see `src/lib/db/client.ts`), so without this the second
    // test in this file would silently keep querying the first test's
    // already-closed temp database rather than the one just created below.
    vi.resetModules();
    const stamp = `${process.pid}-${Math.random().toString(36).slice(2)}`;
    dbPath = path.join(os.tmpdir(), `yana-feeds-route-${stamp}.db`);
    applyMigrationsAt(dbPath);
    process.env.DATABASE_PATH = dbPath;
    process.env.BETTER_AUTH_SECRET = "test-secret-not-used-outside-this-file-0123456789";

    ({ createUserWithPassword, createDeviceSession } = await import("@/lib/auth/server"));
    client = await import("@/lib/db/client");
    schema = await import("@/lib/db/schema");
    ({ GET } = await import("./route"));
  });

  afterEach(() => fs.rmSync(dbPath, { force: true }));

  it("401s with no Authorization header", async () => {
    const response = await GET(new Request("https://example.com/api/v1/feeds"));
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error.code).toBe("unauthorized");
  });

  it("401s with an invalid bearer token", async () => {
    const response = await GET(
      new Request("https://example.com/api/v1/feeds", {
        headers: { authorization: "Bearer not-a-real-token" },
      }),
    );
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error.code).toBe("unauthorized");
  });

  it("returns an empty list with no feeds", async () => {
    const owner = await createUserWithPassword({
      email: "o2@example.com",
      password: "correct horse battery staple",
    });
    const { token } = await createDeviceSession(owner.id, "Test");

    const response = await GET(
      new Request("https://example.com/api/v1/feeds", {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.feeds).toEqual([]);
  });

  it("returns this user's feeds with correct per-feed tagIds, and never another user's feeds", async () => {
    const owner = await createUserWithPassword({
      email: "o@example.com",
      password: "correct horse battery staple",
    });
    const other = await createUserWithPassword({
      email: "other@example.com",
      password: "correct horse battery staple",
    });
    const { token } = await createDeviceSession(owner.id, "Test");

    // Two feeds for `owner`, so the grouping logic is exercised: `feedA` gets
    // both tags, `feedB` gets none, and (below) `feedC` belongs to `other` and
    // shares a tag id number space with `owner`'s tags -- this is what would
    // expose a grouping bug that assigns tags to the wrong feed (e.g. reusing
    // the last-seen feed id instead of grouping by `feedTags.feedId`).
    const feedA = client.writeTransaction((tx) =>
      tx
        .insert(schema.feeds)
        .values({
          name: "A",
          aggregator: "full_website",
          identifier: "https://a",
          userId: owner.id,
        })
        .returning({ id: schema.feeds.id })
        .get(),
    );
    const feedB = client.writeTransaction((tx) =>
      tx
        .insert(schema.feeds)
        .values({
          name: "B",
          aggregator: "full_website",
          identifier: "https://b",
          userId: owner.id,
        })
        .returning({ id: schema.feeds.id })
        .get(),
    );
    // Belongs to `other`, must never appear in `owner`'s response.
    client.writeTransaction((tx) =>
      tx
        .insert(schema.feeds)
        .values({
          name: "C",
          aggregator: "full_website",
          identifier: "https://c",
          userId: other.id,
        })
        .returning({ id: schema.feeds.id })
        .get(),
    );

    const tagNews = client.writeTransaction((tx) =>
      tx
        .insert(schema.tags)
        .values({ name: "News", userId: owner.id })
        .returning({ id: schema.tags.id })
        .get(),
    );
    const tagTech = client.writeTransaction((tx) =>
      tx
        .insert(schema.tags)
        .values({ name: "Tech", userId: owner.id })
        .returning({ id: schema.tags.id })
        .get(),
    );

    client.writeTransaction((tx) => {
      tx.insert(schema.feedTags).values({ feedId: feedA.id, tagId: tagNews.id }).run();
      tx.insert(schema.feedTags).values({ feedId: feedA.id, tagId: tagTech.id }).run();
      // feedB intentionally has zero tags.
    });

    const response = await GET(
      new Request("https://example.com/api/v1/feeds", {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.feeds).toHaveLength(2);

    interface FeedWireForTest {
      id: number;
      name: string;
      tagIds: number[];
    }
    const byName = new Map<string, FeedWireForTest>(
      body.feeds.map((feed: FeedWireForTest) => [feed.name, feed]),
    );
    expect(new Set(byName.get("A")!.tagIds)).toEqual(new Set([tagNews.id, tagTech.id]));
    expect(byName.get("B")!.id).toBe(feedB.id);
    expect(byName.get("B")!.tagIds).toEqual([]);
    expect(byName.get("C")).toBeUndefined();
  });

  it("await connection() is the first statement, before requireApiUser()", async () => {
    // A garbage bearer token would normally 401 -- but if requireApiUser()
    // ran before connection(), a route that dropped the connection() call
    // could not be told apart from one that has it just by hitting this
    // endpoint. This test instead pins the *source order* directly, since
    // that is the actual invariant the self-review asks for and no black-box
    // request can observe it.
    const routeSource = fs.readFileSync(path.join(__dirname, "route.ts"), "utf8");
    const connectionIndex = routeSource.indexOf("connection()");
    const requireApiUserIndex = routeSource.indexOf("requireApiUser(");
    expect(connectionIndex).toBeGreaterThan(-1);
    expect(requireApiUserIndex).toBeGreaterThan(-1);
    expect(connectionIndex).toBeLessThan(requireApiUserIndex);
  });
});
