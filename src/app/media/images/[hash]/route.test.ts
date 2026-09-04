import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { signInCookie } from "@/lib/auth/test-support";
import { applyMigrationsAt } from "@/lib/db/test-support";

const { requestHeaders } = vi.hoisted(() => ({ requestHeaders: { current: new Headers() } }));
vi.mock("next/headers", async () =>
  (await import("@/test/next-headers")).nextHeadersStub(requestHeaders),
);

const REDIRECT = /^NEXT_REDIRECT/;

describe("GET /media/images/[hash]", () => {
  let dbPath: string;
  let mediaPath: string;
  let GET: typeof import("./route").GET;
  let auth: typeof import("@/lib/auth/server").auth;
  let createUserWithPassword: typeof import("@/lib/auth/server").createUserWithPassword;
  let client: typeof import("@/lib/db/client");
  let schema: typeof import("@/lib/db/schema");
  let buildImageRef: typeof import("@/lib/aggregators/images/store").buildImageRef;

  const USER_CREDENTIALS = {
    email: "user@example.com",
    password: "correct horse battery staple",
  };
  const OTHER_CREDENTIALS = {
    email: "other@example.com",
    password: "correct horse battery staple",
  };
  const VALID_HASH = "a".repeat(64);
  const MISSING_HASH = "b".repeat(64);
  const SAMPLE_BYTES = Buffer.from("fake-png-image-bytes");

  function raw(db: unknown): Database.Database {
    return (db as { $client: Database.Database }).$client;
  }

  function requestAs(cookie: string): void {
    requestHeaders.current = new Headers({ cookie });
  }

  function get(hash: string): Promise<Response> {
    return GET(new Request(`http://localhost/media/images/${hash}`), {
      params: Promise.resolve({ hash }),
    });
  }

  /**
   * Everything a caller can observe about a refusal. Two refusals for
   * different reasons must produce identical values here, or the difference
   * is a hash-ownership oracle -- see the route's own doc comment.
   */
  async function observable(response: Response): Promise<unknown> {
    return {
      status: response.status,
      body: await response.text(),
      headers: [...response.headers].sort(),
    };
  }

  beforeEach(async () => {
    vi.resetModules();
    requestHeaders.current = new Headers();

    const stamp = `${process.pid}-${Math.random().toString(36).slice(2)}`;
    dbPath = path.join(os.tmpdir(), `yana-image-route-${stamp}.db`);
    mediaPath = fs.mkdtempSync(path.join(os.tmpdir(), `yana-image-media-${stamp}-`));
    applyMigrationsAt(dbPath);
    process.env.DATABASE_PATH = dbPath;
    process.env.MEDIA_PATH = mediaPath;
    process.env.BETTER_AUTH_SECRET = "test-secret-not-used-outside-this-file-0123456789";

    ({ auth, createUserWithPassword } = await import("@/lib/auth/server"));
    ({ GET } = await import("./route"));
    client = await import("@/lib/db/client");
    schema = await import("@/lib/db/schema");
    ({ buildImageRef } = await import("@/lib/aggregators/images/store"));
  });

  afterEach(() => {
    delete process.env.DATABASE_PATH;
    delete process.env.MEDIA_PATH;
    delete process.env.BETTER_AUTH_SECRET;
    const connection = raw(client.getDb());
    if (connection.open) connection.close();
    for (const suffix of ["", "-shm", "-wal"]) {
      fs.rmSync(`${dbPath}${suffix}`, { force: true });
    }
    fs.rmSync(mediaPath, { recursive: true, force: true });
  });

  function writeMediaFile(relativeFile: string, bytes: Buffer): void {
    const fullPath = path.join(mediaPath, relativeFile);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, bytes);
  }

  function storeImageRow(hash: string, relativeFile: string, contentType = "image/png"): void {
    client.writeTransaction((tx) => {
      tx.insert(schema.articleImages)
        .values({ contentHash: hash, file: relativeFile, contentType, byteSize: 1 })
        .run();
    });
  }

  /** A feed owned by `userId` whose logo *is* `hash` -- the bare-hash root. */
  function ownViaLogo(userId: string, hash: string): void {
    client.writeTransaction((tx) => {
      tx.insert(schema.feeds)
        .values({
          name: "F",
          aggregator: "full_website",
          identifier: `https://example.test/${hash.slice(0, 6)}`,
          userId,
          logoImageHash: hash,
        })
        .run();
    });
  }

  /**
   * A block on an article in a feed owned by `userId` referencing `hash`
   * through one of the two `yana-img://<hash>`-encoded columns.
   */
  function ownViaBlock(userId: string, hash: string, column: "image" | "embed"): void {
    client.writeTransaction((tx) => {
      const feed = tx
        .insert(schema.feeds)
        .values({
          name: "F",
          aggregator: "full_website",
          identifier: `https://example.test/${hash.slice(0, 6)}-${column}`,
          userId,
        })
        .returning({ id: schema.feeds.id })
        .get();
      const article = tx
        .insert(schema.articles)
        .values({
          name: "A",
          identifier: `${hash.slice(0, 6)}-${column}`,
          date: new Date(),
          feedId: feed.id,
        })
        .returning({ id: schema.articles.id })
        .get();
      tx.insert(schema.articleBlocks)
        .values(
          column === "image"
            ? { articleId: article.id, position: 0, kind: "image", imageRef: buildImageRef(hash) }
            : {
                articleId: article.id,
                position: 0,
                kind: "embed",
                embedThumbnailRef: buildImageRef(hash),
              },
        )
        .run();
    });
  }

  async function setupUserAndImage(opts?: { fileExists?: boolean }): Promise<string> {
    const user = await createUserWithPassword({
      ...USER_CREDENTIALS,
      firstName: "A",
      lastName: "B",
    });
    const cookie = await signInCookie(auth, USER_CREDENTIALS);

    const relativeFile = "images/sample.png";
    storeImageRow(VALID_HASH, relativeFile);
    ownViaLogo(user.id, VALID_HASH);

    if (opts?.fileExists !== false) {
      writeMediaFile(relativeFile, SAMPLE_BYTES);
    }

    return cookie;
  }

  it("serves image for a valid hash when authenticated", async () => {
    const cookie = await setupUserAndImage();
    requestAs(cookie);

    const response = await get(VALID_HASH);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await response.arrayBuffer()).equals(SAMPLE_BYTES)).toBe(true);
  });

  it("never lets a shared cache hold a per-caller image", async () => {
    const cookie = await setupUserAndImage();
    requestAs(cookie);

    const cacheControl = (await get(VALID_HASH)).headers.get("cache-control");

    expect(cacheControl).not.toMatch(/public/);
    expect(cacheControl).toBe("private, max-age=31536000, immutable");
  });

  it("refuses an unauthenticated request", async () => {
    await setupUserAndImage();
    requestHeaders.current = new Headers();

    await expect(get(VALID_HASH)).rejects.toMatchObject({
      digest: expect.stringMatching(REDIRECT),
    });
  });

  it("returns 404 for invalid hash format before DB/filesystem access", async () => {
    const cookie = await setupUserAndImage();
    requestAs(cookie);

    for (const invalidHash of [
      "too-short",
      "g".repeat(64), // not hex
      "../../etc/passwd",
      "a".repeat(63),
      "a".repeat(65),
      "",
    ]) {
      const response = await get(invalidHash);
      expect(response.status).toBe(404);
      expect(await response.text()).toBe("");
    }
  });

  it("returns 404 when hash is not in database", async () => {
    const cookie = await setupUserAndImage();
    requestAs(cookie);

    const response = await get(MISSING_HASH);

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("");
  });

  it("returns 404 when file on disk does not exist", async () => {
    const cookie = await setupUserAndImage({ fileExists: false });
    requestAs(cookie);

    const response = await get(VALID_HASH);

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("");
  });

  describe("ownership", () => {
    /**
     * Sign the *other* user in and hand back their cookie. The image itself
     * belongs to `owner` through whichever root the caller of this helper
     * wired up, so this caller must be refused.
     */
    async function otherUserCookie(): Promise<string> {
      await createUserWithPassword({ ...OTHER_CREDENTIALS, firstName: "O", lastName: "U" });
      return signInCookie(auth, OTHER_CREDENTIALS);
    }

    async function ownerId(): Promise<string> {
      const user = await createUserWithPassword({
        ...USER_CREDENTIALS,
        firstName: "A",
        lastName: "B",
      });
      return user.id;
    }

    it.each([
      ["a feed logo (bare-hash root)", "logo" as const],
      ["an article block's imageRef", "image" as const],
      ["an embed block's embedThumbnailRef", "embed" as const],
    ])("refuses a hash reachable only through another user's %s", async (_label, root) => {
      const owner = await ownerId();
      const cookie = await otherUserCookie();

      const hash = "c".repeat(64);
      const relativeFile = "images/other.png";
      writeMediaFile(relativeFile, SAMPLE_BYTES);
      storeImageRow(hash, relativeFile);
      if (root === "logo") ownViaLogo(owner, hash);
      else ownViaBlock(owner, hash, root);

      requestAs(cookie);
      const refused = await get(hash);
      const nonexistent = await get(MISSING_HASH);

      expect(refused.status).toBe(404);
      // Indistinguishable from a hash that was never stored: a 200-vs-404 or
      // any header difference would be an ownership oracle over a hash the
      // caller can read out of a shared article's blocks.
      expect(await observable(refused)).toEqual(await observable(nonexistent));
    });

    it.each([
      ["a feed logo (bare-hash root)", "logo" as const],
      ["an article block's imageRef", "image" as const],
      ["an embed block's embedThumbnailRef", "embed" as const],
    ])("serves a hash the caller owns through %s", async (_label, root) => {
      const owner = await ownerId();
      const cookie = await signInCookie(auth, USER_CREDENTIALS);

      const hash = "d".repeat(64);
      const relativeFile = "images/own.png";
      writeMediaFile(relativeFile, SAMPLE_BYTES);
      storeImageRow(hash, relativeFile);
      if (root === "logo") ownViaLogo(owner, hash);
      else ownViaBlock(owner, hash, root);

      requestAs(cookie);
      const response = await get(hash);

      expect(response.status).toBe(200);
      expect(Buffer.from(await response.arrayBuffer()).equals(SAMPLE_BYTES)).toBe(true);
    });
  });
});
