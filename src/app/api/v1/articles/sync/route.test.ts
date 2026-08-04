import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyMigrationsAt } from "@/lib/db/test-support";

vi.mock("next/server", () => import("@/test/next-server"));

describe("GET /api/v1/articles/sync", () => {
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
    dbPath = path.join(os.tmpdir(), `yana-sync-route-${stamp}.db`);
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
    const response = await GET(new Request("https://example.com/api/v1/articles/sync"));
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error.code).toBe("unauthorized");
  });

  it("401s with an invalid bearer token", async () => {
    const response = await GET(
      new Request("https://example.com/api/v1/articles/sync", {
        headers: { authorization: "Bearer not-a-real-token" },
      }),
    );
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error.code).toBe("unauthorized");
  });

  it("returns this user's articles only, never another user's", async () => {
    const user = await createUserWithPassword({
      email: "a@example.com",
      password: "correct horse battery staple",
    });
    const other = await createUserWithPassword({
      email: "b@example.com",
      password: "correct horse battery staple",
    });
    const { token } = await createDeviceSession(user.id, "Test");

    const feedA = client.writeTransaction((tx) =>
      tx
        .insert(schema.feeds)
        .values({ name: "A", aggregator: "full_website", identifier: "https://a", userId: user.id })
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
          userId: other.id,
        })
        .returning({ id: schema.feeds.id })
        .get(),
    );
    client.writeTransaction((tx) => {
      tx.insert(schema.articles)
        .values({ name: "Mine", identifier: "m1", date: new Date(), feedId: feedA.id })
        .run();
      tx.insert(schema.articles)
        .values({ name: "Theirs", identifier: "t1", date: new Date(), feedId: feedB.id })
        .run();
    });

    const response = await GET(
      new Request("https://example.com/api/v1/articles/sync", {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.new).toHaveLength(1);
    expect(body.new[0].name).toBe("Mine");
    expect(body.updated).toEqual([]);
    expect(body.removed).toEqual([]);
    expect(typeof body.nextCursor).toBe("string");
  });

  it("round-trips the cursor query param: a missing cursor is the first page", async () => {
    const user = await createUserWithPassword({
      email: "c@example.com",
      password: "correct horse battery staple",
    });
    const { token } = await createDeviceSession(user.id, "Test");

    const feed = client.writeTransaction((tx) =>
      tx
        .insert(schema.feeds)
        .values({ name: "F", aggregator: "full_website", identifier: "https://f", userId: user.id })
        .returning({ id: schema.feeds.id })
        .get(),
    );
    client.writeTransaction((tx) => {
      tx.insert(schema.articles)
        .values({ name: "One", identifier: "a1", date: new Date(), feedId: feed.id })
        .run();
    });

    const authHeader = { authorization: `Bearer ${token}` };

    const first = await GET(
      new Request("https://example.com/api/v1/articles/sync", { headers: authHeader }),
    );
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    expect(firstBody.new).toHaveLength(1);

    // An explicit empty cursor must behave identically to no cursor at all.
    const explicitEmpty = await GET(
      new Request("https://example.com/api/v1/articles/sync?cursor=", { headers: authHeader }),
    );
    expect(explicitEmpty.status).toBe(200);
    const explicitEmptyBody = await explicitEmpty.json();
    expect(explicitEmptyBody.new).toHaveLength(1);

    // Following nextCursor forward yields no further "new" rows.
    const second = await GET(
      new Request(
        `https://example.com/api/v1/articles/sync?cursor=${encodeURIComponent(firstBody.nextCursor)}`,
        { headers: authHeader },
      ),
    );
    expect(second.status).toBe(200);
    const secondBody = await second.json();
    expect(secondBody.new).toHaveLength(0);
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
