import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import sharp from "sharp";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { signInCookie } from "@/lib/auth/test-support";
import { applyMigrationsAt } from "@/lib/db/test-support";

import en from "../../../messages/en.json";

/**
 * Real-database tests for `/account`'s server actions, in the style of
 * `src/lib/settings/settings.test.ts`: a temp SQLite file per test, migrated by
 * the same `applyMigrations()` the container runs, and a session minted by the
 * real `/sign-in/email`. No driver mocks.
 *
 * Two things are stubbed, and both are Next's *request scope* rather than any
 * data:
 *
 * - `next/cache`'s `revalidatePath()`, which throws outside a request scope and
 *   has no database behaviour to check.
 * - `next/headers`, which supplies the cookies the session read needs -- and,
 *   here, a **writable cookie jar**. That jar is not decoration: it is the only
 *   place `nextCookies()` can put the session cookie `changePassword()` mints,
 *   and asserting on it is how "the user is still signed in afterwards" is
 *   verified at all. Remove the plugin from `src/lib/auth/server.ts` and the jar
 *   stays empty.
 */
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { requestHeaders, cookieJar } = vi.hoisted(() => ({
  requestHeaders: { current: new Headers() },
  cookieJar: new Map<string, string>(),
}));

vi.mock("next/headers", async () =>
  (await import("@/test/next-headers")).nextHeadersStub(requestHeaders, cookieJar),
);

/** Better Auth's session cookie, by the name it uses with no `advanced.cookiePrefix`. */
const SESSION_COOKIE = "better-auth.session_token";

const MEMBER = { email: "member@example.com", password: "correct horse battery staple" };
const OTHER = { email: "other@example.com", password: "correct horse battery staple" };

describe("the account actions", () => {
  let dbPath: string;
  let mediaPath: string;
  let actions: typeof import("./actions");
  let queries: typeof import("./queries");
  let auth: typeof import("@/lib/auth/server").auth;
  let createUserWithPassword: typeof import("@/lib/auth/server").createUserWithPassword;
  let client: typeof import("@/lib/db/client");
  let avatarLib: typeof import("@/lib/avatar");
  let storage: typeof import("@/lib/avatar-storage");

  /** A real PNG, the kind a user would actually pick. */
  let png: Buffer;

  beforeAll(async () => {
    png = await sharp({
      create: { width: 640, height: 400, channels: 3, background: { r: 9, g: 140, b: 200 } },
    })
      .png()
      .toBuffer();
  });

  function raw(db: unknown): Database.Database {
    return (db as { $client: Database.Database }).$client;
  }

  function query<T>(sql: string, ...params: unknown[]): T {
    const connection = new Database(dbPath);
    try {
      return connection.prepare(sql).get(...(params as [])) as T;
    } finally {
      connection.close();
    }
  }

  /**
   * The `Cookie` header a browser would send next.
   *
   * The jar is *overlaid on* the cookies the current request already carries,
   * not used alone: a refresh may rewrite only the `session_data` cache cookie
   * and leave `session_token` untouched, and a header built from the jar by
   * itself would then be missing the token entirely -- which reads as "signed
   * out" and would blame the code under test for the test's own bookkeeping.
   */
  function nextRequestCookies(): string {
    const jar = new Map<string, string>();
    for (const pair of (requestHeaders.current.get("cookie") ?? "").split(";")) {
      const [name, ...rest] = pair.trim().split("=");
      if (name) jar.set(name, rest.join("="));
    }
    for (const [name, value] of cookieJar) jar.set(name, value);
    return [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  /**
   * The session behind a cookie header, read from the database.
   *
   * `disableCookieCache: true` because a sign-in sets a signed `session_data`
   * cookie as well as the token: without it, `getSession` answers out of that
   * cookie for five minutes and a *revoked* session still reports as live --
   * which would make every revocation assertion below vacuous.
   */
  async function sessionFor(cookie: string) {
    return auth.api.getSession({
      headers: new Headers({ cookie }),
      query: { disableCookieCache: true },
    });
  }

  /** Make every subsequent action call arrive as this cookie's owner. */
  function requestAs(cookie: string): void {
    requestHeaders.current = new Headers({ cookie });
  }

  async function seedAndSignIn(
    credentials: { email: string; password: string } = MEMBER,
  ): Promise<{ id: string; cookie: string }> {
    const user = await createUserWithPassword({
      ...credentials,
      firstName: "Ada",
      lastName: "Lovelace",
    });
    const cookie = await signInCookie(auth, credentials);
    requestAs(cookie);
    cookieJar.clear();
    return { id: user.id, cookie };
  }

  beforeEach(async () => {
    vi.resetModules();
    requestHeaders.current = new Headers();
    cookieJar.clear();

    const stamp = `${process.pid}-${Math.random().toString(36).slice(2)}`;
    dbPath = path.join(os.tmpdir(), `yana-account-${stamp}.db`);
    mediaPath = fs.mkdtempSync(path.join(os.tmpdir(), `yana-account-media-${stamp}-`));
    applyMigrationsAt(dbPath);
    process.env.DATABASE_PATH = dbPath;
    process.env.MEDIA_PATH = mediaPath;
    // Set before the import: Better Auth reads it while building its context.
    process.env.BETTER_AUTH_SECRET = "test-secret-not-used-outside-this-file-0123456789";

    ({ auth, createUserWithPassword } = await import("@/lib/auth/server"));
    actions = await import("./actions");
    queries = await import("./queries");
    client = await import("@/lib/db/client");
    avatarLib = await import("@/lib/avatar");
    storage = await import("@/lib/avatar-storage");
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

  /**
   * Resolve an action's `errorKey` against the real `en.json`.
   *
   * The catalog-parity test only compares the two catalogs to each other; it
   * cannot know that an action emits a key neither defines, which would render
   * the raw dotted path into a toast. Same guard `settings.test.ts` uses.
   */
  function accountMessage(key: string | undefined): unknown {
    if (!key) return undefined;
    return key
      .split(".")
      .reduce<unknown>(
        (node, part) => (node as Record<string, unknown> | undefined)?.[part],
        en.account,
      );
  }

  describe("updateProfile", () => {
    it("persists the three fields and the derived display name", async () => {
      const { id } = await seedAndSignIn();

      const result = await actions.updateProfile({
        email: "ada@example.com",
        firstName: "Augusta",
        lastName: "King",
      });

      expect(result).toEqual({ ok: true });
      expect(query<Record<string, unknown>>("SELECT * FROM users WHERE id = ?", id)).toMatchObject({
        email: "ada@example.com",
        first_name: "Augusta",
        last_name: "King",
        // Better Auth's own display field, and what WebAuthn shows in the
        // browser's passkey chooser -- so it has to move with the two columns.
        name: "Augusta King",
      });
    });

    it("makes the change visible to the very next currentUser(), not in five minutes", async () => {
      // The trap this exists for: `currentUser()` is served from a signed
      // cookie for five minutes, so a direct column write is invisible to
      // every render until it expires -- the sidebar keeps the old name and
      // nothing throws. refreshSession() in the action is what closes that,
      // and it only works because nextCookies() forwards the rewritten cache.
      await seedAndSignIn();
      const session = await import("@/lib/auth/session");

      await actions.updateProfile({
        email: MEMBER.email,
        firstName: "Augusta",
        lastName: "King",
      });
      // The next request carries what the action wrote into the cookie store.
      requestAs(nextRequestCookies());

      expect((await session.currentUser())?.firstName).toBe("Augusta");
    });

    it("refuses an address another account already holds, and writes nothing", async () => {
      await createUserWithPassword(OTHER);
      const { id } = await seedAndSignIn();

      const result = await actions.updateProfile({
        email: OTHER.email,
        firstName: "Ada",
        lastName: "Lovelace",
      });

      expect(result).toEqual({ ok: false, errorKey: "profile.emailTaken" });
      // The key is a real catalog entry, not a path that would render raw.
      expect(accountMessage(result.errorKey)).toBeTypeOf("string");
      expect(query<{ email: string }>("SELECT email FROM users WHERE id = ?", id).email).toBe(
        MEMBER.email,
      );
    });

    it("reports a malformed address as a translated key rather than zod's message", async () => {
      await seedAndSignIn();

      const result = await actions.updateProfile({
        email: "not-an-address",
        firstName: "",
        lastName: "",
      });

      expect(result.ok).toBe(false);
      expect(result.errorKey).toBe("profile.emailInvalid");
      expect(accountMessage(result.errorKey)).toBeTypeOf("string");
    });
  });

  describe("changePassword", () => {
    it("leaves the caller signed in -- which is the whole point of nextCookies()", async () => {
      // `revokeOtherSessions: true` deletes *every* session including this
      // one, then mints a replacement whose cookie Better Auth writes into
      // `ctx.context.responseHeaders`. In a server action there is no HTTP
      // response for those headers to ride on, so unless nextCookies() copies
      // them into Next's cookie store the user is signed out by changing their
      // own password -- silently, under a success toast.
      const { id, cookie } = await seedAndSignIn();

      const result = await actions.changePassword({
        currentPassword: MEMBER.password,
        newPassword: "an entirely new password",
      });

      expect(result).toEqual({ ok: true });
      expect([...cookieJar.keys()]).toContain(SESSION_COOKIE);

      // The replacement works...
      const replacement = await sessionFor(nextRequestCookies());
      expect(replacement?.user.id).toBe(id);
      // ...and it is genuinely a different session, not the old one echoed.
      expect(cookieJar.get(SESSION_COOKIE)).not.toBe("");
      expect(cookie).not.toContain(cookieJar.get(SESSION_COOKIE) ?? "never");
    });

    it("ends sessions on other devices", async () => {
      await seedAndSignIn();
      // A second device: a separate sign-in with its own cookie.
      const elsewhere = await signInCookie(auth, MEMBER);
      // `disableCookieCache` on every one of these reads: the sign-in also
      // handed out a `session_data` cookie, and a cached read would answer
      // from it and report a revoked session as live.
      expect(await sessionFor(elsewhere)).not.toBe(null);
      cookieJar.clear();

      await actions.changePassword({
        currentPassword: MEMBER.password,
        newPassword: "an entirely new password",
      });

      expect(await sessionFor(elsewhere)).toBe(null);
    });

    it("actually rotates the hash, so only the new password signs in", async () => {
      await seedAndSignIn();

      await actions.changePassword({
        currentPassword: MEMBER.password,
        newPassword: "an entirely new password",
      });

      await expect(signInCookie(auth, MEMBER)).rejects.toThrow();
      await expect(
        signInCookie(auth, { email: MEMBER.email, password: "an entirely new password" }),
      ).resolves.toBeTypeOf("string");
    });

    it("reports a wrong current password as a catalog key", async () => {
      await seedAndSignIn();

      const result = await actions.changePassword({
        currentPassword: "not my password",
        newPassword: "an entirely new password",
      });

      expect(result).toEqual({ ok: false, errorKey: "password.wrongCurrent" });
      expect(accountMessage(result.errorKey)).toBeTypeOf("string");
      // And the old password still works -- nothing was rotated.
      await expect(signInCookie(auth, MEMBER)).resolves.toBeTypeOf("string");
    });

    it("rejects a short password before the request, with the same key the server would use", async () => {
      // Pins this module's MIN_PASSWORD_LENGTH against Better Auth's own
      // minimum: if the library's default moved, the endpoint would start
      // refusing passwords zod here accepts.
      await seedAndSignIn();

      const local = await actions.changePassword({
        currentPassword: MEMBER.password,
        newPassword: "short",
      });
      expect(local).toEqual({ ok: false, errorKey: "password.tooShort" });

      const remote = await auth.api.changePassword({
        body: { currentPassword: MEMBER.password, newPassword: "short" },
        headers: requestHeaders.current,
        asResponse: true,
      });
      expect(remote.status).toBe(400);
      expect(await remote.json()).toMatchObject({ code: "PASSWORD_TOO_SHORT" });
    });
  });

  describe("uploadAvatar", () => {
    function upload(file: File): FormData {
      const body = new FormData();
      body.set("avatar", file);
      return body;
    }

    it("stores a 256x256 WebP and points users.image at the route, not the file", async () => {
      const { id } = await seedAndSignIn();

      const result = await actions.uploadAvatar(
        upload(new File([new Uint8Array(png)], "me.png", { type: "image/png" })),
      );

      expect(result).toEqual({ ok: true });

      const file = storage.avatarFilePath(id);
      expect(file).not.toBe(null);
      const stored = await sharp(fs.readFileSync(file as string)).metadata();
      expect(stored.format).toBe("webp");
      expect(stored.width).toBe(avatarLib.AVATAR_SIZE);
      expect(stored.height).toBe(avatarLib.AVATAR_SIZE);

      // The URL, never the path. A filesystem path here resolves relative to
      // /account, 404s, and the initials show forever with nothing thrown --
      // which is why this asserts the exact string rather than "not null".
      const image = query<{ image: string }>("SELECT image FROM users WHERE id = ?", id).image;
      expect(image).toBe(avatarLib.avatarUrlFor(id));
      expect(image).not.toBe(file);
      // And the render-side guard accepts it, which is the property that
      // actually decides whether anything is displayed.
      expect(avatarLib.safeAvatarSrc({ id, image })).toBe(avatarLib.avatarUrlFor(id));
    });

    it("refuses an oversized upload by its declared size, before reading it", async () => {
      await seedAndSignIn();
      const huge = new Uint8Array(avatarLib.AVATAR_MAX_BYTES + 1);

      const result = await actions.uploadAvatar(
        upload(new File([huge], "huge.png", { type: "image/png" })),
      );

      expect(result).toEqual({ ok: false, errorKey: "avatar.tooLarge" });
      expect(fs.existsSync(storage.avatarDirectory())).toBe(false);
    });

    it("refuses it by real byte length when the client lies about the size", async () => {
      // `File.size` comes from the client. A hand-built multipart body can
      // declare anything, so the declared-size check is an optimisation and
      // the post-read length check is the one that holds.
      await seedAndSignIn();
      class UnderstatedFile extends File {
        override get size(): number {
          return 1;
        }
      }
      const huge = new Uint8Array(avatarLib.AVATAR_MAX_BYTES + 1);
      const liar = new UnderstatedFile([huge], "huge.png", { type: "image/png" });
      expect(liar.size).toBe(1);

      const result = await actions.uploadAvatar(upload(liar));

      expect(result).toEqual({ ok: false, errorKey: "avatar.tooLarge" });
      expect(fs.existsSync(storage.avatarDirectory())).toBe(false);
    });

    it("names the megapixel limit when sharp refuses the image", async () => {
      await seedAndSignIn();
      const refused = vi.spyOn(console, "error").mockImplementation(() => {});

      try {
        const result = await actions.uploadAvatar(
          upload(new File([new Uint8Array([1, 2, 3, 4])], "nope.png", { type: "image/png" })),
        );

        expect(result).toEqual({ ok: false, errorKey: "avatar.rejected" });
        // The requirement is not just "an error key": the message the user
        // sees has to state the limit rather than say "processing failed".
        const message = accountMessage(result.errorKey);
        expect(message).toBeTypeOf("string");
        expect(message).toContain("{megapixels}");
        expect(message).not.toMatch(/processing failed/i);
      } finally {
        refused.mockRestore();
      }
    });

    it("refuses an empty submission", async () => {
      await seedAndSignIn();

      const result = await actions.uploadAvatar(
        upload(new File([], "nothing.png", { type: "image/png" })),
      );

      expect(result).toEqual({ ok: false, errorKey: "avatar.noFile" });
    });

    it("re-encodes rather than storing what it was given", async () => {
      // An "image" served back untouched is how an upload becomes stored HTML
      // or an SVG carrying script. The stored bytes must not be the sent ones.
      const { id } = await seedAndSignIn();
      const withTrailingJunk = Buffer.concat([png, Buffer.from("<script>alert(1)</script>")]);

      const result = await actions.uploadAvatar(
        upload(new File([new Uint8Array(withTrailingJunk)], "me.png", { type: "image/png" })),
      );

      expect(result.ok).toBe(true);
      const stored = fs.readFileSync(storage.avatarFilePath(id) as string);
      expect(stored.includes("<script>")).toBe(false);
      expect(stored.equals(withTrailingJunk)).toBe(false);
    });
  });

  describe("removeAvatar", () => {
    it("unlinks the file as well as nulling the column", async () => {
      // Nulling alone is not enough: the media route serves whatever is on
      // disk and never reads users.image, so the old picture would go on being
      // served on a URL that still works.
      const { id } = await seedAndSignIn();
      await actions.uploadAvatar(
        (() => {
          const body = new FormData();
          body.set("avatar", new File([new Uint8Array(png)], "me.png", { type: "image/png" }));
          return body;
        })(),
      );
      const file = storage.avatarFilePath(id) as string;
      expect(fs.existsSync(file)).toBe(true);

      const result = await actions.removeAvatar();

      expect(result).toEqual({ ok: true });
      expect(fs.existsSync(file)).toBe(false);
      expect(
        query<{ image: string | null }>("SELECT image FROM users WHERE id = ?", id).image,
      ).toBe(null);
    });

    it("succeeds when there is nothing to remove", async () => {
      await seedAndSignIn();

      expect(await actions.removeAvatar()).toEqual({ ok: true });
    });
  });

  describe("removePasskey", () => {
    /**
     * A registered passkey, written straight into the table.
     *
     * No test in this phase can drive an authenticator -- `navigator.credentials`
     * does not exist here -- so the *ceremony* is out of reach and stays
     * verified by hand. What this covers is the part that is ours: the guard in
     * front of the delete.
     */
    function plantPasskey(userId: string, suffix: string): string {
      const id = `pk-${suffix}`;
      const connection = new Database(dbPath);
      try {
        connection
          .prepare(
            `INSERT INTO passkeys (id, name, public_key, user_id, credential_id, counter,
             device_type, backed_up, created_at) VALUES (?, ?, ?, ?, ?, 0, 'singleDevice', 0, ?)`,
          )
          .run(id, `Key ${suffix}`, `public-${suffix}`, userId, `cred-${suffix}`, 1_700_000_000);
      } finally {
        connection.close();
      }
      return id;
    }

    function countPasskeys(): number {
      return query<{ count: number }>("SELECT COUNT(*) AS count FROM passkeys").count;
    }

    /** Strip the credential account, leaving passkeys as the only way in. */
    function dropPasswordCredential(userId: string): void {
      const connection = new Database(dbPath);
      try {
        connection
          .prepare("DELETE FROM accounts WHERE user_id = ? AND provider_id = 'credential'")
          .run(userId);
      } finally {
        connection.close();
      }
    }

    it("refuses the last passkey when there is no password to fall back on", async () => {
      // Allowing it leaves an account with no credential of any kind, and this
      // app has no self-registration and no mail transport -- the way back in
      // would be editing SQLite by hand.
      const { id } = await seedAndSignIn();
      const only = plantPasskey(id, "only");
      dropPasswordCredential(id);
      expect(queries.hasPasswordCredential(id)).toBe(false);

      const result = await actions.removePasskey({ id: only });

      expect(result).toEqual({ ok: false, errorKey: "passkeys.lastOneNeedsPassword" });
      expect(accountMessage(result.errorKey)).toBeTypeOf("string");
      expect(countPasskeys()).toBe(1);
    });

    it("allows the last passkey when a password credential exists", async () => {
      // The control the test above needs: without it, a guard that refused
      // every deletion would pass and the feature would be broken.
      const { id } = await seedAndSignIn();
      const only = plantPasskey(id, "only");
      expect(queries.hasPasswordCredential(id)).toBe(true);

      expect(await actions.removePasskey({ id: only })).toEqual({ ok: true });
      expect(countPasskeys()).toBe(0);
    });

    it("allows a passkey that is not the last one, password or not", async () => {
      const { id } = await seedAndSignIn();
      const first = plantPasskey(id, "first");
      plantPasskey(id, "second");
      dropPasswordCredential(id);

      expect(await actions.removePasskey({ id: first })).toEqual({ ok: true });
      expect(countPasskeys()).toBe(1);
    });

    it("refuses somebody else's passkey", async () => {
      const other = await createUserWithPassword(OTHER);
      const theirs = plantPasskey(other.id, "theirs");
      const { id } = await seedAndSignIn();
      plantPasskey(id, "mine");
      const refused = vi.spyOn(console, "error").mockImplementation(() => {});

      try {
        expect(await actions.removePasskey({ id: theirs })).toEqual({ ok: false });
      } finally {
        refused.mockRestore();
      }
      expect(countPasskeys()).toBe(2);
    });
  });

  describe("listDevices / removeDevice", () => {
    /**
     * A device session row, planted directly -- like `plantPasskey` above, this
     * is the part no ceremony can drive from a unit test (there is no real
     * `/device/pair` handshake here), so it stands in for one. Raw SQL rather
     * than `writeTransaction()` because `sessions` is Better Auth's table, not
     * one `writeTransaction()`'s convention governs, and the "no
     * `writeTransaction()` for Better Auth's own writes" exception in
     * CLAUDE.md applies to this table specifically.
     *
     * `expiresAt` defaults far in the future so a planted device reads as live
     * unless a test asks for an expired one. Returns the row's `id`, which is
     * what `removeDevice()` now takes -- never the token, which
     * `DeviceSummary` deliberately never exposes (see finding 2 of the
     * whole-branch review: the token is a live Bearer credential, and this
     * component's props are serialized into `/account`'s RSC payload).
     */
    function plantDeviceSession(
      userId: string,
      token: string,
      opts: { deviceName: string; expiresAt?: Date; createdAt?: Date },
    ): string {
      const id = `sess-${token}`;
      const expiresAt = opts.expiresAt ?? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      const createdAt = opts.createdAt ?? new Date();
      const connection = new Database(dbPath);
      try {
        connection
          .prepare(
            `INSERT INTO sessions (id, token, user_id, expires_at, device_name, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            token,
            userId,
            Math.floor(expiresAt.getTime() / 1000),
            opts.deviceName,
            Math.floor(createdAt.getTime() / 1000),
          );
      } finally {
        connection.close();
      }
      return id;
    }

    function countSessionsWithToken(token: string): number {
      return query<{ count: number }>(
        "SELECT COUNT(*) AS count FROM sessions WHERE token = ?",
        token,
      ).count;
    }

    it("lists paired devices and omits the browser's own session", async () => {
      const { id, cookie } = await seedAndSignIn();
      const deviceId = plantDeviceSession(id, "device-iphone", { deviceName: "iPhone" });

      const devices = await queries.listDevices(id);

      expect(devices).toHaveLength(1);
      expect(devices[0]).toMatchObject({ id: deviceId, deviceName: "iPhone" });
      // Never the token: it is a live Bearer credential, and this projection
      // is what ends up in a client component's props.
      expect(devices[0]).not.toHaveProperty("token");
      // The browser's own session (minted by seedAndSignIn/signInCookie) has no
      // deviceName, and must never appear alongside a real device.
      expect(devices.some((device) => device.id === cookie)).toBe(false);
    });

    it("orders devices newest-first", async () => {
      const { id } = await seedAndSignIn();
      plantDeviceSession(id, "device-older", {
        deviceName: "Older",
        createdAt: new Date(Date.now() - 60_000),
      });
      plantDeviceSession(id, "device-newer", {
        deviceName: "Newer",
        createdAt: new Date(),
      });

      const devices = await queries.listDevices(id);

      expect(devices.map((device) => device.deviceName)).toEqual(["Newer", "Older"]);
    });

    it("omits an expired device session", async () => {
      // Better Auth never deletes a session just because it lapsed -- it only
      // refuses to extend it -- so an unfiltered read would offer a dead
      // session as a "device" to revoke, with no effect if the user tried.
      const { id } = await seedAndSignIn();
      plantDeviceSession(id, "device-expired", {
        deviceName: "Expired Device",
        expiresAt: new Date(Date.now() - 60_000),
      });
      plantDeviceSession(id, "device-live", { deviceName: "Live Device" });

      const devices = await queries.listDevices(id);

      expect(devices.map((device) => device.deviceName)).toEqual(["Live Device"]);
    });

    it("omits another user's device session", async () => {
      const other = await createUserWithPassword(OTHER);
      plantDeviceSession(other.id, "device-theirs", { deviceName: "Their Phone" });
      const { id } = await seedAndSignIn();
      const mineId = plantDeviceSession(id, "device-mine", { deviceName: "My Phone" });

      const devices = await queries.listDevices(id);

      expect(devices.map((device) => device.id)).toEqual([mineId]);
    });

    it("revokes a device session by id, so it disappears and the row is gone", async () => {
      const { id } = await seedAndSignIn();
      const deviceId = plantDeviceSession(id, "device-ipad", { deviceName: "iPad" });
      expect(countSessionsWithToken("device-ipad")).toBe(1);

      const result = await actions.removeDevice({ id: deviceId });

      expect(result).toEqual({ ok: true });
      expect(await queries.listDevices(id)).toEqual([]);
      // Not just filtered out of the list -- the row itself is gone, so the
      // token can never authenticate a device session again either.
      expect(countSessionsWithToken("device-ipad")).toBe(0);
    });

    it("leaves the caller's own browser session alone", async () => {
      // There is no "last device" lockout here, unlike the last-passkey guard:
      // the browser's own cookie session is never one of the rows revokeDevice
      // can touch, because it carries no deviceName.
      const { id, cookie } = await seedAndSignIn();
      const deviceId = plantDeviceSession(id, "device-only", { deviceName: "Only Device" });

      await actions.removeDevice({ id: deviceId });

      expect(await sessionFor(cookie)).not.toBe(null);
    });

    it("refuses to revoke a device session belonging to a different user", async () => {
      // The finding this test exists for: `removeDevice()` now resolves the
      // id to a token itself, scoped to `userId = caller.id` -- a local
      // ownership check that runs *before* Better Auth's own endpoint is ever
      // called. An id that exists but belongs to someone else must therefore
      // be refused outright, rather than relying on `revokeSession`'s own
      // (silent) mismatch handling as the only guard.
      const other = await createUserWithPassword(OTHER);
      const theirsId = plantDeviceSession(other.id, "device-theirs", {
        deviceName: "Their Phone",
      });
      await seedAndSignIn();

      const result = await actions.removeDevice({ id: theirsId });

      expect(result).toEqual({ ok: false });
      expect(countSessionsWithToken("device-theirs")).toBe(1);
    });

    it("refuses an id that does not exist at all", async () => {
      await seedAndSignIn();

      const result = await actions.removeDevice({ id: "no-such-session" });

      expect(result).toEqual({ ok: false });
    });
  });

  describe("the Server Action body limit", () => {
    it("leaves room above the avatar limit, so the avatar limit is the one that fires", async () => {
      // Next rejects an action request body over `bodySizeLimit` *before* the
      // action runs, so a cap at or below AVATAR_MAX_BYTES makes
      // uploadAvatar()'s own limit unreachable and turns an ordinary
      // 1.5 MB photograph into a framework error with no translated message.
      // Measured in a browser; pinned here so nobody lowers it back.
      const { default: config } = await import("../../../next.config");
      const limit = config.experimental?.serverActions?.bodySizeLimit;

      expect(typeof limit).toBe("string");
      const kilobytes = Number(String(limit).replace(/kb$/i, ""));
      expect(Number.isFinite(kilobytes)).toBe(true);
      expect(kilobytes * 1024).toBeGreaterThan(avatarLib.AVATAR_MAX_BYTES);
    });
  });

  describe("currentUserRow", () => {
    it("sees a write the cached session cannot", async () => {
      // The defect this exists for, caught in a browser: after a profile save
      // the sidebar footer went on showing the old name until a full reload.
      // `currentUser()` answers out of a five-minute signed cookie *and*
      // React's per-request cache() freezes even that, so the re-render the
      // action triggers reads back the value it just replaced.
      const { id } = await seedAndSignIn();
      const session = await import("@/lib/auth/session");
      const { eq } = await import("drizzle-orm");
      const schema = await import("@/lib/db/schema");

      // Warm the session read, the way a real request's gate does.
      expect((await session.currentUser())?.firstName).toBe("Ada");

      client.writeTransaction((tx) =>
        tx.update(schema.users).set({ firstName: "Grace" }).where(eq(schema.users.id, id)).run(),
      );

      // The cached session still says Ada -- that is the trap, stated.
      expect((await session.currentUser())?.firstName).toBe("Ada");
      // The row read does not.
      expect((await session.currentUserRow()).firstName).toBe("Grace");
    });
  });

  describe("getAccountOverview", () => {
    it("reads the row from the database, not the five-minute session cache", async () => {
      // The account page is the one screen whose job is showing these columns
      // back to their owner, so a cached copy is exactly the wrong source.
      const { id } = await seedAndSignIn();
      // Written behind the session's back, exactly the way a stale cookie
      // cache would hide it. Same module epoch as `client` above -- no
      // resetModules() in between -- so this is the table object the singleton
      // connection actually knows.
      const { eq } = await import("drizzle-orm");
      const schema = await import("@/lib/db/schema");
      client.writeTransaction((tx) =>
        tx.update(schema.users).set({ firstName: "Grace" }).where(eq(schema.users.id, id)).run(),
      );

      const overview = await queries.getAccountOverview();

      expect(overview.user.firstName).toBe("Grace");
      expect(overview.hasPassword).toBe(true);
      expect(overview.passkeys).toEqual([]);
      expect(overview.devices).toEqual([]);
    });
  });
});
