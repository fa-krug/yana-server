import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyMigrationsAt } from "@/lib/db/test-support";

vi.mock("next/server", () => import("@/test/next-server"));

describe("GET /api/v1/images/[hash]", () => {
  let dbPath: string;
  let mediaDir: string;
  let GET: typeof import("./route").GET;
  let auth: typeof import("@/lib/auth/server").auth;
  let createUserWithPassword: typeof import("@/lib/auth/server").createUserWithPassword;
  let createDeviceSession: typeof import("@/lib/auth/server").createDeviceSession;
  let signInCookie: typeof import("@/lib/auth/test-support").signInCookie;
  let client: typeof import("@/lib/db/client");
  let schema: typeof import("@/lib/db/schema");
  let buildImageRef: typeof import("@/lib/aggregators/images/store").buildImageRef;

  const CREDENTIALS = { password: "correct horse battery staple" };

  beforeEach(async () => {
    // Fresh module registry per test -- `getDb()` is a lazy module-level
    // singleton, so without this later tests would keep querying an already
    // -closed temp database from an earlier test. See other route tests for
    // the same reasoning.
    vi.resetModules();

    const stamp = `${process.pid}-${Math.random().toString(36).slice(2)}`;
    dbPath = path.join(os.tmpdir(), `yana-images-route-${stamp}.db`);
    mediaDir = await fs.mkdtemp(path.join(os.tmpdir(), `yana-images-media-${stamp}-`));
    applyMigrationsAt(dbPath);
    process.env.DATABASE_PATH = dbPath;
    process.env.MEDIA_PATH = mediaDir;
    process.env.BETTER_AUTH_SECRET = "test-secret-not-used-outside-this-file-0123456789";

    ({ auth, createUserWithPassword, createDeviceSession } = await import("@/lib/auth/server"));
    ({ signInCookie } = await import("@/lib/auth/test-support"));
    client = await import("@/lib/db/client");
    schema = await import("@/lib/db/schema");
    ({ buildImageRef } = await import("@/lib/aggregators/images/store"));
    ({ GET } = await import("./route"));
  });

  afterEach(async () => {
    delete process.env.DATABASE_PATH;
    delete process.env.MEDIA_PATH;
    delete process.env.BETTER_AUTH_SECRET;
    await fs.rm(dbPath, { force: true });
    await fs.rm(mediaDir, { recursive: true, force: true });
  });

  /** Write a file under the media root and return its relative path. */
  async function writeMediaFile(relativeFile: string, bytes: Buffer): Promise<void> {
    const absolute = path.join(mediaDir, relativeFile);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, bytes);
  }

  function get(hash: string, headers: Record<string, string> = {}): Promise<Response> {
    return GET(new Request(`https://example.com/api/v1/images/${hash}`, { headers }), {
      params: Promise.resolve({ hash }),
    });
  }

  it("401s with no Authorization header and no cookie", async () => {
    const response = await get("f".repeat(64));
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error.code).toBe("unauthorized");
  });

  it("serves bytes for a hash owned via the caller's own feed logo", async () => {
    const owner = await createUserWithPassword({ email: "logo-owner@example.com", ...CREDENTIALS });
    const { token } = await createDeviceSession(owner.id, "Test");

    const hash = "a".repeat(64);
    const relativeFile = "article_images/aaaa.webp";
    await writeMediaFile(relativeFile, Buffer.from([1, 2, 3]));

    client.writeTransaction((tx) => {
      tx.insert(schema.articleImages)
        .values({ contentHash: hash, file: relativeFile, contentType: "image/webp", byteSize: 3 })
        .run();
      tx.insert(schema.feeds)
        .values({
          name: "F",
          aggregator: "full_website",
          identifier: "https://x",
          userId: owner.id,
          logoImageHash: hash,
        })
        .run();
    });

    const response = await get(hash, { authorization: `Bearer ${token}` });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/webp");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from([1, 2, 3]));
  });

  it("serves bytes for a hash owned via an article block on the caller's own article", async () => {
    // A genuinely separate ownership path from the logo one above: this hash
    // is never a feed's logoImageHash anywhere, and reaches the caller only
    // through article_blocks -> articles -> feeds. Note the block stores the
    // *ref* string (yana-img://<hash>), not the bare hash -- getting that
    // join wrong (comparing imageRef to the bare hash) would always miss.
    const owner = await createUserWithPassword({
      email: "block-owner@example.com",
      ...CREDENTIALS,
    });
    const { token } = await createDeviceSession(owner.id, "Test");

    const hash = "b".repeat(64);
    const relativeFile = "article_images/bbbb.webp";
    await writeMediaFile(relativeFile, Buffer.from([4, 5, 6, 7]));

    client.writeTransaction((tx) => {
      tx.insert(schema.articleImages)
        .values({ contentHash: hash, file: relativeFile, contentType: "image/webp", byteSize: 4 })
        .run();
      const feed = tx
        .insert(schema.feeds)
        .values({
          name: "F",
          aggregator: "full_website",
          identifier: "https://x",
          userId: owner.id,
        })
        .returning({ id: schema.feeds.id })
        .get();
      const article = tx
        .insert(schema.articles)
        .values({ name: "A", identifier: "a1", date: new Date(), feedId: feed.id })
        .returning({ id: schema.articles.id })
        .get();
      tx.insert(schema.articleBlocks)
        .values({
          articleId: article.id,
          position: 0,
          kind: "image",
          imageRef: buildImageRef(hash),
        })
        .run();
    });

    const response = await get(hash, { authorization: `Bearer ${token}` });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/webp");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from([4, 5, 6, 7]));
  });

  it("404s for a hash owned only by a different user, via the logo path", async () => {
    const owner = await createUserWithPassword({ email: "owner-only@example.com", ...CREDENTIALS });
    const other = await createUserWithPassword({
      email: "other-caller@example.com",
      ...CREDENTIALS,
    });
    const { token } = await createDeviceSession(other.id, "Test");

    const hash = "e".repeat(64);
    await writeMediaFile("article_images/eeee.webp", Buffer.from([1]));
    client.writeTransaction((tx) => {
      tx.insert(schema.articleImages)
        .values({
          contentHash: hash,
          file: "article_images/eeee.webp",
          contentType: "image/webp",
          byteSize: 1,
        })
        .run();
      tx.insert(schema.feeds)
        .values({
          name: "F",
          aggregator: "full_website",
          identifier: "https://x",
          userId: owner.id,
          logoImageHash: hash,
        })
        .run();
    });

    const response = await get(hash, { authorization: `Bearer ${token}` });
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error.code).toBe("not_found");
  });

  it("404s for a hash owned only by a different user, via the article-block path", async () => {
    const owner = await createUserWithPassword({
      email: "owner-only-2@example.com",
      ...CREDENTIALS,
    });
    const other = await createUserWithPassword({
      email: "other-caller-2@example.com",
      ...CREDENTIALS,
    });
    const { token } = await createDeviceSession(other.id, "Test");

    const hash = "c".repeat(64);
    await writeMediaFile("article_images/cccc.webp", Buffer.from([1]));
    client.writeTransaction((tx) => {
      tx.insert(schema.articleImages)
        .values({
          contentHash: hash,
          file: "article_images/cccc.webp",
          contentType: "image/webp",
          byteSize: 1,
        })
        .run();
      const feed = tx
        .insert(schema.feeds)
        .values({
          name: "F",
          aggregator: "full_website",
          identifier: "https://x",
          userId: owner.id,
        })
        .returning({ id: schema.feeds.id })
        .get();
      const article = tx
        .insert(schema.articles)
        .values({ name: "A", identifier: "a1", date: new Date(), feedId: feed.id })
        .returning({ id: schema.articles.id })
        .get();
      tx.insert(schema.articleBlocks)
        .values({
          articleId: article.id,
          position: 0,
          kind: "image",
          imageRef: buildImageRef(hash),
        })
        .run();
    });

    const response = await get(hash, { authorization: `Bearer ${token}` });
    expect(response.status).toBe(404);
  });

  it("404s for a well-formed hash that exists but nobody's feed or article reaches", async () => {
    const owner = await createUserWithPassword({
      email: "orphan-owner@example.com",
      ...CREDENTIALS,
    });
    const { token } = await createDeviceSession(owner.id, "Test");

    const hash = "d".repeat(64);
    await writeMediaFile("article_images/dddd.webp", Buffer.from([1]));
    client.writeTransaction((tx) => {
      tx.insert(schema.articleImages)
        .values({
          contentHash: hash,
          file: "article_images/dddd.webp",
          contentType: "image/webp",
          byteSize: 1,
        })
        .run();
    });

    const response = await get(hash, { authorization: `Bearer ${token}` });
    expect(response.status).toBe(404);
  });

  it.each([
    ["too-short", "abc123"],
    ["uppercase-hex", "A".repeat(64)],
    ["non-hex-characters", "g".repeat(64)],
    ["path-traversal-attempt", "../../etc/passwd"],
  ])("404s for a malformed hash (%s) without querying the database", async (label, hash) => {
    const owner = await createUserWithPassword({
      email: `malformed-${label}@example.com`,
      ...CREDENTIALS,
    });
    const { token } = await createDeviceSession(owner.id, "Test");

    // requireApiUser() itself performs exactly one query (the Bearer-token
    // lookup in userForBearerToken()); resolving the caller before validating
    // the hash is deliberate (see requireApiUser's doc comment on ordering).
    // Spying here proves the *hash* is never used in a query: a call count of
    // 1 means only that auth lookup ran, and neither ownsHash()'s two queries
    // nor the final articleImages lookup ever executed.
    const getDbSpy = vi.spyOn(client, "getDb");

    const response = await get(encodeURIComponent(hash), { authorization: `Bearer ${token}` });

    expect(response.status).toBe(404);
    expect(getDbSpy).toHaveBeenCalledTimes(1);
  });

  it("serves the same bytes to the web UI's cookie-based caller, with no Bearer header", async () => {
    const owner = await createUserWithPassword({
      email: "cookie-owner@example.com",
      ...CREDENTIALS,
    });
    const cookie = await signInCookie(auth, { email: "cookie-owner@example.com", ...CREDENTIALS });

    const hash = "9".repeat(64);
    const relativeFile = "article_images/nine.webp";
    await writeMediaFile(relativeFile, Buffer.from([9, 9, 9]));
    client.writeTransaction((tx) => {
      tx.insert(schema.articleImages)
        .values({ contentHash: hash, file: relativeFile, contentType: "image/webp", byteSize: 3 })
        .run();
      tx.insert(schema.feeds)
        .values({
          name: "F",
          aggregator: "full_website",
          identifier: "https://x",
          userId: owner.id,
          logoImageHash: hash,
        })
        .run();
    });

    const response = await get(hash, { cookie });

    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from([9, 9, 9]));
  });

  it("await connection() is the first statement, before requireApiUser()", async () => {
    // Same reasoning as src/app/api/v1/articles/[id]/content/route.test.ts:
    // this pins the source order directly, since no black-box request can
    // observe it (a Bearer-token caller never touches next/headers either,
    // so nothing else opts this route out of prerendering).
    const routeSource = await fs.readFile(
      path.join(process.cwd(), "src/app/api/v1/images/[hash]/route.ts"),
      "utf8",
    );
    const connectionIndex = routeSource.indexOf("await connection();");
    const requireApiUserIndex = routeSource.indexOf("await requireApiUser(request);");
    expect(connectionIndex).toBeGreaterThan(-1);
    expect(requireApiUserIndex).toBeGreaterThan(-1);
    expect(connectionIndex).toBeLessThan(requireApiUserIndex);
  });
});
