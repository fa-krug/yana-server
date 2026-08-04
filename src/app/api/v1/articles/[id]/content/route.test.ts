import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyMigrationsAt } from "@/lib/db/test-support";
import type { Block } from "@/lib/aggregators/blocks/types";

vi.mock("next/server", () => import("@/test/next-server"));

describe("GET /api/v1/articles/[id]/content", () => {
  let dbPath: string;
  let GET: typeof import("./route").GET;
  let createUserWithPassword: typeof import("@/lib/auth/server").createUserWithPassword;
  let createDeviceSession: typeof import("@/lib/auth/server").createDeviceSession;
  let client: typeof import("@/lib/db/client");
  let schema: typeof import("@/lib/db/schema");
  let writeBlocks: typeof import("@/lib/aggregators/blocks/storage").writeBlocks;
  let encodeDocument: typeof import("@/lib/aggregators/blocks/schema").encodeDocument;

  beforeEach(async () => {
    // A fresh module registry per test: `getDb()` is a lazy module-level
    // singleton (see `src/lib/db/client.ts`), so without this the second
    // test in this file would silently keep querying the first test's
    // already-closed temp database rather than the one just created below.
    vi.resetModules();
    const stamp = `${process.pid}-${Math.random().toString(36).slice(2)}`;
    dbPath = path.join(os.tmpdir(), `yana-content-route-${stamp}.db`);
    applyMigrationsAt(dbPath);
    process.env.DATABASE_PATH = dbPath;
    process.env.BETTER_AUTH_SECRET = "test-secret-not-used-outside-this-file-0123456789";

    ({ createUserWithPassword, createDeviceSession } = await import("@/lib/auth/server"));
    client = await import("@/lib/db/client");
    schema = await import("@/lib/db/schema");
    ({ writeBlocks } = await import("@/lib/aggregators/blocks/storage"));
    ({ encodeDocument } = await import("@/lib/aggregators/blocks/schema"));
    ({ GET } = await import("./route"));
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

  it("401s with no Authorization header", async () => {
    const response = await GET(new Request("https://example.com/api/v1/articles/1/content"), {
      params: Promise.resolve({ id: "1" }),
    });
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error.code).toBe("unauthorized");
  });

  it("404s for another user's article", async () => {
    const owner = await createUserWithPassword({
      email: "owner@example.com",
      password: "correct horse battery staple",
    });
    const other = await createUserWithPassword({
      email: "other@example.com",
      password: "correct horse battery staple",
    });
    const { token } = await createDeviceSession(other.id, "Test");

    const articleId = await seedArticle(owner.id);

    const response = await GET(
      new Request(`https://example.com/api/v1/articles/${articleId}/content`, {
        headers: { authorization: `Bearer ${token}` },
      }),
      { params: Promise.resolve({ id: String(articleId) }) },
    );
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error.code).toBe("not_found");
  });

  it("404s for a nonexistent article id", async () => {
    const owner = await createUserWithPassword({
      email: "owner-missing@example.com",
      password: "correct horse battery staple",
    });
    const { token } = await createDeviceSession(owner.id, "Test");

    const response = await GET(
      new Request("https://example.com/api/v1/articles/999999/content", {
        headers: { authorization: `Bearer ${token}` },
      }),
      { params: Promise.resolve({ id: "999999" }) },
    );
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error.code).toBe("not_found");
  });

  it("404s for a non-numeric article id", async () => {
    const owner = await createUserWithPassword({
      email: "owner-nan@example.com",
      password: "correct horse battery staple",
    });
    const { token } = await createDeviceSession(owner.id, "Test");

    const response = await GET(
      new Request("https://example.com/api/v1/articles/not-a-number/content", {
        headers: { authorization: `Bearer ${token}` },
      }),
      { params: Promise.resolve({ id: "not-a-number" }) },
    );
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error.code).toBe("not_found");
  });

  it("returns an empty block document when no blocks were written for the article", async () => {
    const owner = await createUserWithPassword({
      email: "owner-empty@example.com",
      password: "correct horse battery staple",
    });
    const { token } = await createDeviceSession(owner.id, "Test");

    const articleId = await seedArticle(owner.id);

    const response = await GET(
      new Request(`https://example.com/api/v1/articles/${articleId}/content`, {
        headers: { authorization: `Bearer ${token}` },
      }),
      { params: Promise.resolve({ id: String(articleId) }) },
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ version: 1, blocks: [] });
  });

  it("round-trips a real, nested block tree for the owner", async () => {
    const owner = await createUserWithPassword({
      email: "owner-real@example.com",
      password: "correct horse battery staple",
    });
    const { token } = await createDeviceSession(owner.id, "Test");

    const articleId = await seedArticle(owner.id);

    // A tree exercising nesting (list > list_item > paragraph), inline run
    // styling, and a handful of leaf kinds -- deliberately not just a lone
    // paragraph, so this test cannot pass on an accidentally-empty response.
    const blocks: Block[] = [
      {
        kind: "heading",
        level: 2,
        runs: [{ text: "Title", bold: true }],
      },
      {
        kind: "paragraph",
        runs: [{ text: "Hello, " }, { text: "world", bold: true, link: "https://example.com" }],
      },
      {
        kind: "list",
        ordered: true,
        items: [
          [{ kind: "paragraph", runs: [{ text: "first item" }] }],
          [{ kind: "paragraph", runs: [{ text: "second item" }] }],
        ],
      },
      {
        kind: "image",
        ref: "yana-img://deadbeef",
        caption: [{ text: "a caption" }],
      },
      { kind: "divider" },
    ];

    await writeBlocks(articleId, blocks);

    const response = await GET(
      new Request(`https://example.com/api/v1/articles/${articleId}/content`, {
        headers: { authorization: `Bearer ${token}` },
      }),
      { params: Promise.resolve({ id: String(articleId) }) },
    );
    expect(response.status).toBe(200);
    const body = await response.json();

    // Assert against the real encoder rather than a hand-written literal, so
    // this test tracks the wire format instead of duplicating it -- but the
    // fixture above still has to be nontrivial for that comparison to prove
    // anything about round-tripping through storage.
    expect(body).toEqual(encodeDocument(blocks));
    expect(body.blocks).toHaveLength(5);
    expect(body.blocks[1].runs[1]).toEqual({
      text: "world",
      styles: ["bold"],
      link: "https://example.com",
    });
    expect(body.blocks[2].items).toHaveLength(2);
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
