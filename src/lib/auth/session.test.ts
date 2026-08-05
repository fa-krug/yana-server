import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { signInCookie } from "@/lib/auth/test-support";
import { applyMigrationsAt } from "@/lib/db/test-support";

/**
 * The request headers `next/headers` hands back. A hoisted box, not a module in
 * `src/test/`, because every test here calls `vi.resetModules()` -- a stub
 * imported inside the factory would be re-instantiated on the next epoch and
 * lose whatever the test had set.
 *
 * This stubs Next's *request scope*, which no unit test can boot -- the same
 * category as the `next/navigation` router stub, and explicitly not a database
 * mock: everything below runs against a real migrated SQLite file, and the
 * cookies in these headers are real ones minted by a real sign-in.
 */
const { requestHeaders } = vi.hoisted(() => ({ requestHeaders: { current: new Headers() } }));
vi.mock("next/headers", async () =>
  (await import("@/test/next-headers")).nextHeadersStub(requestHeaders),
);

/** `redirect()` and `notFound()` are not stubbed -- these are their real digests. */
const REDIRECT = /^NEXT_REDIRECT/;
const NOT_FOUND = /^NEXT_HTTP_ERROR_FALLBACK;404/;

function digestOf(error: unknown): string {
  return String((error as { digest?: unknown }).digest);
}

/** Run `call`, and return the `digest` of the control-flow error it threw. */
async function digestFrom(call: Promise<unknown>): Promise<string> {
  try {
    await call;
  } catch (error) {
    return digestOf(error);
  }
  throw new Error("expected a redirect() or notFound() to be thrown, but the call returned");
}

describe("the session helpers", () => {
  let dbPath: string;
  let session: typeof import("./session");
  let auth: typeof import("./server").auth;
  let createUserWithPassword: typeof import("./server").createUserWithPassword;
  let client: typeof import("@/lib/db/client");
  let schema: typeof import("@/lib/db/schema");

  const ADMIN = { email: "admin@admin.com", password: "admin" };
  const MEMBER = { email: "member@example.com", password: "correct horse battery staple" };

  function raw(db: unknown): Database.Database {
    return (db as { $client: Database.Database }).$client;
  }

  /** Make every subsequent helper call arrive with this cookie header. */
  function requestAs(cookie: string): void {
    requestHeaders.current = new Headers({ cookie });
  }

  beforeEach(async () => {
    vi.resetModules();
    requestHeaders.current = new Headers();
    dbPath = path.join(
      os.tmpdir(),
      `yana-session-${process.pid}-${Math.random().toString(36).slice(2)}.db`,
    );
    applyMigrationsAt(dbPath);
    process.env.DATABASE_PATH = dbPath;
    // Set before the import: Better Auth reads it while building its context.
    process.env.BETTER_AUTH_SECRET = "test-secret-not-used-outside-this-file-0123456789";

    // The administrator comes from the real bootstrap, exactly as it does at
    // server start -- not from a fixture row, which could diverge from what a
    // running instance actually holds.
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await (await import("./bootstrap")).ensureAdminExists();
    } finally {
      warned.mockRestore();
    }

    ({ auth, createUserWithPassword } = await import("./server"));
    session = await import("./session");
    client = await import("@/lib/db/client");
    // Same module epoch as `client`, so these are the table objects bound to
    // the connection getDb() opened -- see settings.test.ts.
    schema = await import("@/lib/db/schema");
  });

  afterEach(() => {
    delete process.env.DATABASE_PATH;
    delete process.env.BETTER_AUTH_SECRET;
    const connection = raw(client.getDb());
    if (connection.open) connection.close();
    for (const suffix of ["", "-shm", "-wal"]) {
      fs.rmSync(`${dbPath}${suffix}`, { force: true });
    }
  });

  /** A second, non-administrative account, signed in. */
  async function seedMember(): Promise<{ id: string; cookie: string }> {
    const user = await createUserWithPassword({ ...MEMBER, name: "Member" });
    return { id: user.id, cookie: await signInCookie(auth, MEMBER) };
  }

  describe("currentUser", () => {
    it("is null when the request carries no session cookie", async () => {
      await expect(session.currentUser()).resolves.toBe(null);
    });

    it("is null when the cookie is not one this server signed", async () => {
      // A forged token, shaped like a real one. Middleware lets this through by
      // design -- it only sees that *a* cookie exists -- so this is the read
      // that has to refuse it.
      requestAs("better-auth.session_token=not-a-real-token.not-a-real-signature");

      await expect(session.currentUser()).resolves.toBe(null);
    });
  });

  describe("currentUserFresh", () => {
    it("returns the signed-in user", async () => {
      requestAs(await signInCookie(auth, ADMIN));

      await expect(session.currentUserFresh()).resolves.toMatchObject({ email: ADMIN.email });
    });

    it("is null when there is no session", async () => {
      await expect(session.currentUserFresh()).resolves.toBe(null);
    });

    it("is null once the user's row (and their cascade-deleted session row) is gone, unlike the cached currentUser()", async () => {
      // This is the loop /login used to have with the (app) layout's
      // currentUserRow(): that redirects here on a real database miss, and if
      // this page trusted the same signature-only cookie cache as
      // currentUser(), it would see the same stale "signed in" and bounce
      // straight back -- forever, until the cache's own five-minute window
      // expired.
      const member = await seedMember();
      requestAs(member.cookie);

      client.writeTransaction((tx) => {
        tx.delete(schema.users).where(eq(schema.users.id, member.id)).run();
      });

      // The cached read still reports a signed-in user -- session.cookieCache
      // trusts its own signature alone, with no database read. Asserted, not
      // assumed: if the cookie cache were off, the check below would pass for
      // the wrong reason and this test would prove nothing.
      await expect(session.currentUser()).resolves.toMatchObject({ email: MEMBER.email });

      // currentUserFresh() forces the database read Better Auth's session
      // endpoint does; the sessions row was cascade-deleted with the user, so
      // it correctly answers null instead of reporting a signed-in user.
      await expect(session.currentUserFresh()).resolves.toBe(null);
    });
  });

  describe("currentUserId", () => {
    it("resolves whoever is signed in, not the oldest administrator", async () => {
      // The interim body this replaced returned the first admin regardless of
      // the request. A non-admin session must resolve to the non-admin.
      const member = await seedMember();
      requestAs(member.cookie);

      await expect(session.currentUserId()).resolves.toBe(member.id);
    });

    it("gives two concurrent sessions their own identity", async () => {
      // The per-process memo that used to live in src/lib/settings/queries.ts
      // would fail exactly here: whichever request arrived first would decide
      // the answer for every other one, and every user would read and overwrite
      // that one user's settings. Deliberately interleaved rather than run in
      // sequence, so a memo could not be excused as "cleared between requests".
      const member = await seedMember();
      const adminCookie = await signInCookie(auth, ADMIN);

      requestAs(adminCookie);
      const first = await session.currentUserId();
      requestAs(member.cookie);
      const second = await session.currentUserId();
      requestAs(adminCookie);
      const third = await session.currentUserId();

      expect(second).toBe(member.id);
      expect(first).not.toBe(second);
      expect(third).toBe(first);
    });

    it("redirects to the login page when there is no session", async () => {
      expect(await digestFrom(session.currentUserId())).toMatch(REDIRECT);
      expect(await digestFrom(session.currentUserId())).toContain("/login");
    });
  });

  describe("requireUser", () => {
    it("returns the signed-in user", async () => {
      requestAs(await signInCookie(auth, ADMIN));

      const user = await session.requireUser();

      expect(user.email).toBe(ADMIN.email);
      // The full row, not Better Auth's minimal user: phase 5+ reads these.
      expect(user.role).toBe("admin");
      expect(user).toHaveProperty("firstName");
    });

    it("redirects to the login page when there is no session", async () => {
      expect(await digestFrom(session.requireUser())).toMatch(REDIRECT);
    });
  });

  describe("isLoginRedirect", () => {
    it("recognises what this version of Next's redirect() actually throws", async () => {
      // The predicate matches on `digest`, an implementation detail Next
      // exports no test for -- so it is pinned against a real thrown redirect
      // rather than a hand-built error. If a Next upgrade changes the shape,
      // this fails here instead of turning the root layout's signed-out path
      // into a /login redirect loop.
      let thrown: unknown;
      try {
        await session.requireUser();
      } catch (error) {
        thrown = error;
      }

      expect(session.isLoginRedirect(thrown)).toBe(true);
    });

    it("does not swallow an ordinary error", async () => {
      // The branch it guards falls back to English and logs nothing, so a
      // predicate that said yes to a database failure would hide it completely.
      expect(session.isLoginRedirect(new Error("database is locked"))).toBe(false);
      expect(session.isLoginRedirect(null)).toBe(false);
      expect(session.isLoginRedirect(undefined)).toBe(false);
    });
  });

  describe("currentUserRow", () => {
    it("returns the signed-in user's row", async () => {
      requestAs(await signInCookie(auth, ADMIN));

      await expect(session.currentUserRow()).resolves.toMatchObject({ email: ADMIN.email });
    });

    it("redirects to login instead of crashing when the session names a user who no longer has a row", async () => {
      // The case this guards is not exotic: a session cookie survives far
      // longer than a development database does. Wipe or recreate `data/`
      // (a fresh migration, a branch switch, `rm -rf data/`) while the
      // browser still holds an old signed cookie, and the *cookie* verifies
      // fine -- session.cookieCache trusts its own signature, no database
      // read -- while the id it names has no `users` row in the fresh file.
      // Simulated here by deleting the row out from under a live session,
      // which is the same shape for the rarer production case (an account
      // removed while its session was still live).
      const member = await seedMember();
      requestAs(member.cookie);

      client.writeTransaction((tx) => {
        tx.delete(schema.users).where(eq(schema.users.id, member.id)).run();
      });

      expect(await digestFrom(session.currentUserRow())).toMatch(REDIRECT);
    });
  });

  describe("requireAdmin", () => {
    it("returns the administrator", async () => {
      requestAs(await signInCookie(auth, ADMIN));

      await expect(session.requireAdmin()).resolves.toMatchObject({
        email: ADMIN.email,
        role: "admin",
      });
    });

    it("answers 404 rather than 403 for a signed-in non-admin", async () => {
      // 403 would confirm the route exists. A non-admin has no reason to learn
      // that, so the response is indistinguishable from a wrong URL.
      const member = await seedMember();
      requestAs(member.cookie);

      expect(await digestFrom(session.requireAdmin())).toMatch(NOT_FOUND);
    });

    it("redirects to the login page when there is no session", async () => {
      expect(await digestFrom(session.requireAdmin())).toMatch(REDIRECT);
    });

    it("refuses a demoted admin whose cookie cache still says admin", async () => {
      // The correctness heart of this task. session.cookieCache serves the whole
      // user object -- role included -- out of a signed cookie for five minutes
      // with no database read, so an admin demoted a moment ago keeps
      // administrative authority for as long as that cookie lives.
      requestAs(await signInCookie(auth, ADMIN));
      const admin = await session.requireAdmin();

      client.writeTransaction((tx) => {
        tx.update(schema.users).set({ role: "user" }).where(eq(schema.users.id, admin.id)).run();
      });

      // The cached read still reports the stale role. Asserted, not assumed: if
      // the cookie cache were off (or not populated by sign-in), the check below
      // would pass for the wrong reason and this test would prove nothing.
      await expect(session.currentUser()).resolves.toMatchObject({ role: "admin" });

      // requireAdmin() passes disableCookieCache, so it sees the demotion.
      expect(await digestFrom(session.requireAdmin())).toMatch(NOT_FOUND);
    });
  });

  describe("requireUserFreshRole", () => {
    it("returns the signed-in user", async () => {
      requestAs(await signInCookie(auth, ADMIN));

      const user = await session.requireUserFreshRole();

      expect(user.email).toBe(ADMIN.email);
      expect(user.role).toBe("admin");
    });

    it("redirects to the login page when there is no session", async () => {
      expect(await digestFrom(session.requireUserFreshRole())).toMatch(REDIRECT);
    });

    it("does not gate a non-admin -- unlike requireAdmin(), it still returns them", async () => {
      const member = await seedMember();
      requestAs(member.cookie);

      await expect(session.requireUserFreshRole()).resolves.toMatchObject({
        email: MEMBER.email,
        role: "user",
      });
    });

    it("reflects a demoted admin's role immediately, unlike the cached currentUser()", async () => {
      // The correctness heart of this fix, mirroring requireAdmin()'s own
      // "refuses a demoted admin whose cookie cache still says admin" test:
      // session.cookieCache serves the whole user object -- role included --
      // out of a signed cookie for five minutes with no database read, so an
      // admin demoted a moment ago would still read as an admin to any caller
      // trusting that cache.
      requestAs(await signInCookie(auth, ADMIN));
      const admin = await session.requireUserFreshRole();
      expect(admin.role).toBe("admin");

      client.writeTransaction((tx) => {
        tx.update(schema.users).set({ role: "user" }).where(eq(schema.users.id, admin.id)).run();
      });

      // The cached read still reports the stale role. Asserted, not assumed:
      // if the cookie cache were off (or not populated by sign-in), the check
      // below would pass for the wrong reason and this test would prove
      // nothing.
      await expect(session.currentUser()).resolves.toMatchObject({ role: "admin" });

      // requireUserFreshRole() passes disableCookieCache, so it sees the
      // demotion -- and, unlike requireAdmin(), still returns the user rather
      // than 404ing, because its callers must keep serving a non-admin.
      await expect(session.requireUserFreshRole()).resolves.toMatchObject({
        id: admin.id,
        role: "user",
      });
    });
  });
});
