import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyMigrationsAt } from "@/lib/db/test-support";

describe("POST /api/v1/articles/[id]/reload", () => {
  let dbPath: string;
  let POST: typeof import("./route").POST;
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
    dbPath = path.join(os.tmpdir(), `yana-articles-reload-route-${stamp}.db`);
    applyMigrationsAt(dbPath);
    process.env.DATABASE_PATH = dbPath;
    process.env.BETTER_AUTH_SECRET = "test-secret-not-used-outside-this-file-0123456789";

    ({ createUserWithPassword, createDeviceSession } = await import("@/lib/auth/server"));
    client = await import("@/lib/db/client");
    schema = await import("@/lib/db/schema");
    ({ POST } = await import("./route"));
  });

  afterEach(() => fs.rmSync(dbPath, { force: true }));

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

  function reloadRequest(articleId: number | string, token: string) {
    return POST(
      new Request(`https://example.com/api/v1/articles/${articleId}/reload`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      }),
      { params: Promise.resolve({ id: String(articleId) }) },
    );
  }

  it("401s with no Authorization header", async () => {
    const response = await POST(
      new Request("https://example.com/api/v1/articles/1/reload", { method: "POST" }),
      { params: Promise.resolve({ id: "1" }) },
    );
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error.code).toBe("unauthorized");
  });

  it("enqueues an article.reload job scoped to the owner", async () => {
    const owner = await createUserWithPassword({
      email: "o@example.com",
      password: "correct horse battery staple",
    });
    const { token } = await createDeviceSession(owner.id, "Test");
    const articleId = await seedArticle(owner.id);

    const response = await reloadRequest(articleId, token);

    expect(response.status).toBe(202);
    const body = await response.json();
    expect(typeof body.jobId).toBe("number");

    const job = client
      .getDb()
      .select()
      .from(schema.jobs)
      .where(eq(schema.jobs.id, body.jobId))
      .get();
    expect(job?.kind).toBe("article.reload");
    expect(job?.payload).toMatchObject({ articleId });
  });

  it("404s for another user's article and enqueues no job", async () => {
    const owner = await createUserWithPassword({
      email: "o2@example.com",
      password: "correct horse battery staple",
    });
    const other = await createUserWithPassword({
      email: "o3@example.com",
      password: "correct horse battery staple",
    });
    const { token } = await createDeviceSession(other.id, "Test");
    const articleId = await seedArticle(owner.id);

    const response = await reloadRequest(articleId, token);

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error.code).toBe("not_found");

    // The leak-prevention check: a direct query on `jobs`, not just the
    // response, proves the ownership mismatch never reached the INSERT.
    const allJobs = client.getDb().select().from(schema.jobs).all();
    expect(allJobs).toHaveLength(0);
  });

  it("404s for a nonexistent article id", async () => {
    const owner = await createUserWithPassword({
      email: "o-missing@example.com",
      password: "correct horse battery staple",
    });
    const { token } = await createDeviceSession(owner.id, "Test");

    const response = await reloadRequest(999999, token);

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error.code).toBe("not_found");
    const allJobs = client.getDb().select().from(schema.jobs).all();
    expect(allJobs).toHaveLength(0);
  });

  it("404s for a non-numeric article id", async () => {
    const owner = await createUserWithPassword({
      email: "o-nan@example.com",
      password: "correct horse battery staple",
    });
    const { token } = await createDeviceSession(owner.id, "Test");

    const response = await reloadRequest("not-a-number", token);

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error.code).toBe("not_found");
  });
});
