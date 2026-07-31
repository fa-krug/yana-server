import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type Database from "better-sqlite3";
import sharp from "sharp";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { signInCookie } from "@/lib/auth/test-support";
import { applyMigrationsAt } from "@/lib/db/test-support";

/**
 * The request headers `next/headers` hands back -- a hoisted box, for the same
 * reason `src/lib/auth/session.test.ts` uses one: every test here calls
 * `vi.resetModules()`, and a stub imported inside the factory would not survive
 * it. This stubs Next's *request scope*, not the database: the file below runs
 * against a real migrated SQLite file, and the cookies are real ones minted by
 * a real sign-in through the real `/sign-in/email` endpoint.
 */
const { requestHeaders } = vi.hoisted(() => ({ requestHeaders: { current: new Headers() } }));
// `cookies()` is stubbed alongside `headers()` because Better Auth's
// `nextCookies()` plugin (registered last in src/lib/auth/server.ts) calls it
// after any endpoint that sets a cookie, and `vitest.config.ts` inlines that
// plugin so the stub is what it receives. A `cookies` that is `undefined`
// throws a TypeError the plugin does not catch. Nothing here reads the jar --
// see src/lib/account/account.test.ts for the test that does.
const noCookieStore = () =>
  Promise.resolve({
    set: () => {},
    get: () => undefined,
    delete: () => {},
  });
vi.mock("next/headers", () => ({
  headers: () => Promise.resolve(requestHeaders.current),
  cookies: noCookieStore,
}));

/** The real digest `redirect()` throws; not stubbed. */
const REDIRECT = /^NEXT_REDIRECT/;

describe("GET /media/avatars/[userId]", () => {
  let dbPath: string;
  let mediaPath: string;
  let GET: typeof import("./route").GET;
  let auth: typeof import("@/lib/auth/server").auth;
  let createUserWithPassword: typeof import("@/lib/auth/server").createUserWithPassword;
  let avatarFilePath: typeof import("@/lib/avatar-storage").avatarFilePath;
  let client: typeof import("@/lib/db/client");

  const OWNER = { email: "owner@example.com", password: "correct horse battery staple" };
  const OTHER = { email: "other@example.com", password: "correct horse battery staple" };

  /**
   * The file on disk, produced by the real `processAvatar()` -- because that is
   * the only thing allowed to write into this directory, and the handler's
   * fixed `Content-Type` is only honest if the bytes really are WebP.
   *
   * Nothing uploads yet (task 6 does), so the tests plant it by hand.
   */
  let avatarBytes: Buffer;

  beforeAll(async () => {
    const { processAvatar } = await import("@/lib/avatar-storage");
    const source = await sharp({
      create: { width: 400, height: 300, channels: 3, background: { r: 9, g: 140, b: 200 } },
    })
      .png()
      .toBuffer();
    avatarBytes = await processAvatar(source);
  });

  function raw(db: unknown): Database.Database {
    return (db as { $client: Database.Database }).$client;
  }

  /** Make every subsequent call arrive with this cookie header. */
  function requestAs(cookie: string): void {
    requestHeaders.current = new Headers({ cookie });
  }

  /** Call the handler the way Next would: `params` is a promise in Next 16. */
  function get(userId: string): Promise<Response> {
    return GET(new Request(`http://localhost/media/avatars/${userId}`), {
      params: Promise.resolve({ userId }),
    });
  }

  beforeEach(async () => {
    vi.resetModules();
    requestHeaders.current = new Headers();

    const stamp = `${process.pid}-${Math.random().toString(36).slice(2)}`;
    dbPath = path.join(os.tmpdir(), `yana-avatar-route-${stamp}.db`);
    mediaPath = fs.mkdtempSync(path.join(os.tmpdir(), `yana-avatar-media-${stamp}-`));
    applyMigrationsAt(dbPath);
    process.env.DATABASE_PATH = dbPath;
    process.env.MEDIA_PATH = mediaPath;
    // Set before the import: Better Auth reads it while building its context.
    process.env.BETTER_AUTH_SECRET = "test-secret-not-used-outside-this-file-0123456789";

    ({ auth, createUserWithPassword } = await import("@/lib/auth/server"));
    ({ avatarFilePath } = await import("@/lib/avatar-storage"));
    ({ GET } = await import("./route"));
    client = await import("@/lib/db/client");
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

  /** Create an account and put an avatar file on disk for it. */
  async function seed(
    credentials: { email: string; password: string },
    withAvatar: boolean,
  ): Promise<{ id: string; cookie: string }> {
    const user = await createUserWithPassword({ ...credentials, firstName: "A", lastName: "B" });
    if (withAvatar) {
      const file = avatarFilePath(user.id);
      if (!file) throw new Error(`the id Better Auth minted is not avatar-shaped: ${user.id}`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, avatarBytes);
    }
    return { id: user.id, cookie: await signInCookie(auth, credentials) };
  }

  it("serves the caller their own avatar, as WebP", async () => {
    const owner = await seed(OWNER, true);
    requestAs(owner.cookie);

    const response = await get(owner.id);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/webp");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    // Declined deliberately -- the URL carries no version token, so any
    // freshness lifetime would survive a re-upload. See the handler's comment.
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(Buffer.from(await response.arrayBuffer()).equals(avatarBytes)).toBe(true);
  });

  it("refuses an unauthenticated request", async () => {
    // The single most important assertion in this file. Nothing above a route
    // handler authenticates: src/proxy.ts checks only that *a* session cookie
    // exists and never validates it, and a route handler has no layout. Without
    // the requireUser() call inside the handler, this returns the bytes.
    const owner = await seed(OWNER, true);
    requestHeaders.current = new Headers();

    await expect(get(owner.id)).rejects.toMatchObject({
      digest: expect.stringMatching(REDIRECT),
    });
  });

  it("refuses a cookie this server did not sign", async () => {
    // What the proxy waves through: a session cookie by name only.
    const owner = await seed(OWNER, true);
    requestAs("better-auth.session_token=not-a-real-token.not-a-real-signature");

    await expect(get(owner.id)).rejects.toMatchObject({
      digest: expect.stringMatching(REDIRECT),
    });
  });

  it("refuses a signed-in caller another user's avatar", async () => {
    const owner = await seed(OWNER, true);
    const other = await seed(OTHER, false);
    requestAs(other.cookie);

    const response = await get(owner.id);

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("");
  });

  it("answers a wrong id exactly as it answers a missing file", async () => {
    // 200-vs-404 on someone else's id would be a user-id enumeration oracle, so
    // "not yours" and "you have none" have to be the same response.
    const owner = await seed(OWNER, true);
    const other = await seed(OTHER, false);
    requestAs(other.cookie);

    const foreign = await get(owner.id);
    const mine = await get(other.id);
    const nobody = await get("q".repeat(32));

    for (const response of [foreign, mine, nobody]) {
      expect(response.status).toBe(404);
      expect([...response.headers.keys()]).toEqual([]);
      expect(await response.text()).toBe("");
    }
  });

  /**
   * Traversal. Each of these is refused by the id comparison first and by
   * `avatarFilePath()`'s whole-string allow-list second -- never by stripping
   * anything out of the segment, which is how traversal bugs survive.
   */
  it.each([
    ["a parent-directory hop", "../../etc/passwd"],
    ["a hop onto a sibling file", "../secret"],
    ["a bare parent reference", ".."],
    ["an absolute path", "/etc/passwd"],
    ["a Windows separator", "..\\..\\secret"],
    ["a percent-encoded hop", "%2e%2e%2fsecret"],
    ["an embedded NUL", "abc\0"],
    ["the id with an extension", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.webp"],
    ["an empty segment", ""],
  ])("refuses %s", async (_label, segment) => {
    const owner = await seed(OWNER, true);
    requestAs(owner.cookie);
    // A readable file just outside the avatars directory, so a handler that
    // did escape would have something to hand back and this would fail loudly.
    fs.writeFileSync(path.join(mediaPath, "secret.webp"), "TOP SECRET");
    fs.writeFileSync(path.join(mediaPath, "secret"), "TOP SECRET");

    const response = await get(segment);

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("");
  });

  it("cannot be reached by dressing the traversal up as the caller's own id", async () => {
    // The path is built from `user.id`, never from the segment, so even a
    // segment that starts with the real id gets nowhere.
    const owner = await seed(OWNER, true);
    requestAs(owner.cookie);

    expect((await get(`${owner.id}/../../secret`)).status).toBe(404);
    expect((await get(`${owner.id}.webp`)).status).toBe(404);

    // The comparison is exact, so a case-folded id is somebody else's id.
    const lowered = owner.id.toLowerCase();
    if (lowered !== owner.id) expect((await get(lowered)).status).toBe(404);
  });

  it("pins the id shape against an id Better Auth actually minted", async () => {
    // The tripwire for `USER_ID` in avatar-storage.ts. If a future
    // `advanced.generateId` changes the format, avatars would silently 404 for
    // everyone; this fails first, with the real id in the message.
    const user = await createUserWithPassword({
      email: "shape@example.com",
      password: "correct horse battery staple",
    });

    expect(avatarFilePath(user.id), `id was ${JSON.stringify(user.id)}`).not.toBe(null);
  });
});
