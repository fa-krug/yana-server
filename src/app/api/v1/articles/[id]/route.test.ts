import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyMigrationsAt } from "@/lib/db/test-support";

vi.mock("next/server", () => import("@/test/next-server"));

describe("PATCH /api/v1/articles/[id]", () => {
  let dbPath: string;
  let PATCH: typeof import("./route").PATCH;
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
    dbPath = path.join(os.tmpdir(), `yana-articles-patch-route-${stamp}.db`);
    applyMigrationsAt(dbPath);
    process.env.DATABASE_PATH = dbPath;
    process.env.BETTER_AUTH_SECRET = "test-secret-not-used-outside-this-file-0123456789";

    ({ createUserWithPassword, createDeviceSession } = await import("@/lib/auth/server"));
    client = await import("@/lib/db/client");
    schema = await import("@/lib/db/schema");
    ({ PATCH } = await import("./route"));
  });

  afterEach(() => fs.rmSync(dbPath, { force: true }));

  async function seedArticle(
    userId: string,
    overrides: { read?: boolean; starred?: boolean } = {},
  ) {
    const feed = client.writeTransaction((tx) =>
      tx
        .insert(schema.feeds)
        .values({ name: "F", aggregator: "full_website", identifier: "https://x", userId })
        .returning({ id: schema.feeds.id })
        .get(),
    );
    const article = client.writeTransaction((tx) =>
      tx
        .insert(schema.articles)
        .values({
          name: "A",
          identifier: "a1",
          date: new Date(),
          feedId: feed.id,
          read: overrides.read ?? false,
          starred: overrides.starred ?? false,
        })
        .returning({ id: schema.articles.id })
        .get(),
    );
    return article.id as number;
  }

  function patchRequest(articleId: number | string, body: unknown, token: string) {
    return PATCH(
      new Request(`https://example.com/api/v1/articles/${articleId}`, {
        method: "PATCH",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id: String(articleId) }) },
    );
  }

  it("401s with no Authorization header", async () => {
    const response = await PATCH(
      new Request("https://example.com/api/v1/articles/1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ starred: true }),
      }),
      { params: Promise.resolve({ id: "1" }) },
    );
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error.code).toBe("unauthorized");
  });

  it("toggles starred and returns the full updated ArticleSummaryWire", async () => {
    const owner = await createUserWithPassword({
      email: "o@example.com",
      password: "correct horse battery staple",
    });
    const { token } = await createDeviceSession(owner.id, "Test");
    const articleId = await seedArticle(owner.id);

    const response = await patchRequest(articleId, { starred: true }, token);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      id: articleId,
      feedId: expect.any(Number),
      name: "A",
      identifier: "a1",
      date: expect.any(String),
      author: "",
      icon: null,
      read: false,
      starred: true,
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
  });

  it("PATCHing only starred leaves read untouched", async () => {
    const owner = await createUserWithPassword({
      email: "o-read@example.com",
      password: "correct horse battery staple",
    });
    const { token } = await createDeviceSession(owner.id, "Test");
    const articleId = await seedArticle(owner.id, { read: true, starred: false });

    const response = await patchRequest(articleId, { starred: true }, token);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.starred).toBe(true);
    expect(body.read).toBe(true);
  });

  it("PATCHing only read leaves starred untouched", async () => {
    const owner = await createUserWithPassword({
      email: "o-starred@example.com",
      password: "correct horse battery staple",
    });
    const { token } = await createDeviceSession(owner.id, "Test");
    const articleId = await seedArticle(owner.id, { read: false, starred: true });

    const response = await patchRequest(articleId, { read: true }, token);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.read).toBe(true);
    expect(body.starred).toBe(true);
  });

  it("400s when neither starred nor read is present in the body", async () => {
    const owner = await createUserWithPassword({
      email: "o-empty@example.com",
      password: "correct horse battery staple",
    });
    const { token } = await createDeviceSession(owner.id, "Test");
    const articleId = await seedArticle(owner.id);

    const response = await patchRequest(articleId, {}, token);

    expect(response.status).toBe(400);
    const row = client
      .getDb()
      .select()
      .from(schema.articles)
      .where(eq(schema.articles.id, articleId))
      .get();
    expect(row?.starred).toBe(false);
    expect(row?.read).toBe(false);
  });

  it("400s on a malformed body (wrong type)", async () => {
    const owner = await createUserWithPassword({
      email: "o-bad@example.com",
      password: "correct horse battery staple",
    });
    const { token } = await createDeviceSession(owner.id, "Test");
    const articleId = await seedArticle(owner.id);

    const response = await patchRequest(articleId, { starred: "yes" }, token);

    expect(response.status).toBe(400);
  });

  it("404s for a nonexistent article id", async () => {
    const owner = await createUserWithPassword({
      email: "o-missing@example.com",
      password: "correct horse battery staple",
    });
    const { token } = await createDeviceSession(owner.id, "Test");

    const response = await patchRequest(999999, { starred: true }, token);

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error.code).toBe("not_found");
  });

  it("404s for a non-numeric article id", async () => {
    const owner = await createUserWithPassword({
      email: "o-nan@example.com",
      password: "correct horse battery staple",
    });
    const { token } = await createDeviceSession(owner.id, "Test");

    const response = await patchRequest("not-a-number", { starred: true }, token);

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error.code).toBe("not_found");
  });

  it("404s for another user's article and leaves the row genuinely unchanged", async () => {
    const owner = await createUserWithPassword({
      email: "o2@example.com",
      password: "correct horse battery staple",
    });
    const other = await createUserWithPassword({
      email: "o3@example.com",
      password: "correct horse battery staple",
    });
    const { token } = await createDeviceSession(other.id, "Test");
    const articleId = await seedArticle(owner.id, { starred: false, read: false });

    const response = await patchRequest(articleId, { starred: true, read: true }, token);
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error.code).toBe("not_found");

    // The leak-prevention check: a direct DB read, not just the response,
    // proves the UPDATE never touched this row. If the route re-SELECTed
    // unconditionally after a 0-row UPDATE (skipping the `changes` check),
    // this assertion would still pass but the response above would have
    // leaked the other user's article as a 200 -- so this test only proves
    // the point together with the `expect(response.status).toBe(404)` above.
    const row = client
      .getDb()
      .select()
      .from(schema.articles)
      .where(eq(schema.articles.id, articleId))
      .get();
    expect(row?.starred).toBe(false);
    expect(row?.read).toBe(false);
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
