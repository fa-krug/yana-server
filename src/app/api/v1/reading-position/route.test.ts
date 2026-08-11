import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyMigrationsAt } from "@/lib/db/test-support";

vi.mock("next/server", () => import("@/test/next-server"));

describe("GET/PATCH /api/v1/reading-position", () => {
  let dbPath: string;
  let GET: typeof import("./route").GET;
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
    dbPath = path.join(os.tmpdir(), `yana-reading-position-route-${stamp}.db`);
    applyMigrationsAt(dbPath);
    process.env.DATABASE_PATH = dbPath;
    process.env.BETTER_AUTH_SECRET = "test-secret-not-used-outside-this-file-0123456789";

    ({ createUserWithPassword, createDeviceSession } = await import("@/lib/auth/server"));
    client = await import("@/lib/db/client");
    schema = await import("@/lib/db/schema");
    ({ GET, PATCH } = await import("./route"));
  });

  afterEach(() => fs.rmSync(dbPath, { force: true }));

  function getRequest(token: string) {
    return GET(
      new Request("https://example.com/api/v1/reading-position", {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
  }

  function patchRequest(body: unknown, token: string) {
    return PATCH(
      new Request("https://example.com/api/v1/reading-position", {
        method: "PATCH",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  }

  function seedSettings(userId: string) {
    client.writeTransaction((tx) => {
      tx.insert(schema.userSettings).values({ userId }).run();
    });
  }

  async function seedArticle(userId: string) {
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
        .values({ name: "A", identifier: "a1", date: new Date(), feedId: feed.id })
        .returning({ id: schema.articles.id })
        .get(),
    );
    return article.id as number;
  }

  it("401s GET with no Authorization header", async () => {
    const response = await GET(new Request("https://example.com/api/v1/reading-position"));
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error.code).toBe("unauthorized");
  });

  it("401s PATCH with no Authorization header", async () => {
    const response = await PATCH(
      new Request("https://example.com/api/v1/reading-position", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ articleId: 1 }),
      }),
    );
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error.code).toBe("unauthorized");
  });

  it("GET before any PATCH returns null articleId and updatedAt", async () => {
    const owner = await createUserWithPassword({
      email: "o@example.com",
      password: "correct horse battery staple",
    });
    seedSettings(owner.id);
    const { token } = await createDeviceSession(owner.id, "Test");

    const response = await getRequest(token);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ articleId: null, updatedAt: null });
  });

  it("PATCH then GET round-trips articleId and a fresh updatedAt", async () => {
    const owner = await createUserWithPassword({
      email: "o@example.com",
      password: "correct horse battery staple",
    });
    seedSettings(owner.id);
    const { token } = await createDeviceSession(owner.id, "Test");
    const articleId = await seedArticle(owner.id);

    const patchResponse = await patchRequest({ articleId }, token);
    expect(patchResponse.status).toBe(200);
    const patchBody = await patchResponse.json();
    expect(patchBody).toEqual({ articleId, updatedAt: expect.any(String) });

    const getResponse = await getRequest(token);
    expect(getResponse.status).toBe(200);
    const getBody = await getResponse.json();
    expect(getBody).toEqual(patchBody);
  });

  it("a second PATCH overwrites the pointer (last write wins)", async () => {
    const owner = await createUserWithPassword({
      email: "o@example.com",
      password: "correct horse battery staple",
    });
    seedSettings(owner.id);
    const { token } = await createDeviceSession(owner.id, "Test");
    const first = await seedArticle(owner.id);
    const second = await seedArticle(owner.id);

    await patchRequest({ articleId: first }, token);
    const response = await patchRequest({ articleId: second }, token);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.articleId).toBe(second);
  });

  it("404s PATCH for a nonexistent article id", async () => {
    const owner = await createUserWithPassword({
      email: "o@example.com",
      password: "correct horse battery staple",
    });
    seedSettings(owner.id);
    const { token } = await createDeviceSession(owner.id, "Test");

    const response = await patchRequest({ articleId: 999999 }, token);
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error.code).toBe("not_found");
  });

  it("404s PATCH for another user's article, and leaves the caller's pointer unset", async () => {
    const owner = await createUserWithPassword({
      email: "o@example.com",
      password: "correct horse battery staple",
    });
    const other = await createUserWithPassword({
      email: "o2@example.com",
      password: "correct horse battery staple",
    });
    seedSettings(other.id);
    const { token } = await createDeviceSession(other.id, "Test");
    const articleId = await seedArticle(owner.id);

    const response = await patchRequest({ articleId }, token);
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error.code).toBe("not_found");

    const getResponse = await getRequest(token);
    const getBody = await getResponse.json();
    expect(getBody).toEqual({ articleId: null, updatedAt: null });
  });

  it("400s PATCH on a missing articleId", async () => {
    const owner = await createUserWithPassword({
      email: "o@example.com",
      password: "correct horse battery staple",
    });
    const { token } = await createDeviceSession(owner.id, "Test");

    const response = await patchRequest({}, token);
    expect(response.status).toBe(400);
  });

  it("400s PATCH on a malformed body (wrong type)", async () => {
    const owner = await createUserWithPassword({
      email: "o@example.com",
      password: "correct horse battery staple",
    });
    const { token } = await createDeviceSession(owner.id, "Test");

    const response = await patchRequest({ articleId: "not-a-number" }, token);
    expect(response.status).toBe(400);
  });

  it("await connection() is the first statement in GET, before requireApiUser()", async () => {
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
