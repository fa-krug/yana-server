import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ADMIN_ROLE, isAdminRole } from "@/lib/auth/roles";
import { signInCookie } from "@/lib/auth/test-support";
import type { ListParams } from "@/lib/crud/params";
import { applyMigrationsAt } from "@/lib/db/test-support";

import en from "../../../messages/en.json";

/**
 * Real-database tests for the admin-only users tab's data layer, in the style
 * of `src/lib/account/account.test.ts`: a temp SQLite file per test, migrated
 * by the same `applyMigrations()` the container runs, and an acting
 * administrator signed in through the real `/sign-in/email`. No driver mocks.
 *
 * Two things are stubbed, and both are Next's *request scope* rather than any
 * data: `next/cache`'s `revalidatePath()` (which throws outside a request
 * scope) and `next/headers` (which supplies the cookies every `requireAdmin()`
 * reads, and the writable jar `refreshSession()` needs a place to write to).
 */
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { requestHeaders, cookieJar } = vi.hoisted(() => ({
  requestHeaders: { current: new Headers() },
  cookieJar: new Map<string, string>(),
}));

vi.mock("next/headers", async () =>
  (await import("@/test/next-headers")).nextHeadersStub(requestHeaders, cookieJar),
);

const PASSWORD = "correct horse battery staple";
const ADMIN = { email: "admin@example.com", password: PASSWORD };

describe("the users queries and actions", () => {
  let dbPath: string;
  let mediaPath: string;
  let actions: typeof import("./actions");
  let queries: typeof import("./queries");
  let auth: typeof import("@/lib/auth/server").auth;
  let createUserWithPassword: typeof import("@/lib/auth/server").createUserWithPassword;
  let client: typeof import("@/lib/db/client");
  let schema: typeof import("@/lib/db/schema");

  /** Memoized per test by `currentAdminId()` below. */
  let actingAdmin: string | undefined;
  /** The acting admin's cookie, so a test that signs somebody else in can come back. */
  let adminCookie: string;

  function raw(db: unknown): Database.Database {
    return (db as { $client: Database.Database }).$client;
  }

  function all<T>(sql: string, ...params: unknown[]): T[] {
    const connection = new Database(dbPath);
    try {
      return connection.prepare(sql).all(...(params as [])) as T[];
    } finally {
      connection.close();
    }
  }

  function one<T>(sql: string, ...params: unknown[]): T {
    const connection = new Database(dbPath);
    try {
      return connection.prepare(sql).get(...(params as [])) as T;
    } finally {
      connection.close();
    }
  }

  /** Write a column no application path writes -- the ban columns have no UI. */
  function execute(sql: string, ...params: unknown[]): void {
    const connection = new Database(dbPath);
    try {
      connection.prepare(sql).run(...(params as []));
    } finally {
      connection.close();
    }
  }

  /**
   * The `Cookie` header a browser would send next: the current request's
   * cookies with anything the action just wrote overlaid. Same bookkeeping as
   * `account.test.ts`, and for the same reason -- a refresh may rewrite only
   * the `session_data` cookie, so a header built from the jar alone would be
   * missing the token and read as "signed out".
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

  function requestAs(cookie: string): void {
    requestHeaders.current = new Headers({ cookie });
  }

  async function seedUser(input: {
    email: string;
    role?: string;
    firstName?: string;
    lastName?: string;
  }): Promise<string> {
    const user = await createUserWithPassword({
      email: input.email,
      password: PASSWORD,
      firstName: input.firstName ?? "",
      lastName: input.lastName ?? "",
      role: input.role,
    });
    return user.id;
  }

  /**
   * The acting administrator. **A real signed-in account, not just a row**:
   * every action here starts at `requireAdmin()`, which reads the session from
   * the database with the cookie cache disabled, so a seeded row alone would
   * make every call 404.
   */
  async function currentAdminId(): Promise<string> {
    if (actingAdmin) return actingAdmin;
    actingAdmin = await seedUser({ ...ADMIN, role: ADMIN_ROLE, firstName: "Ada" });
    adminCookie = await signInCookie(auth, ADMIN);
    requestAs(adminCookie);
    cookieJar.clear();
    return actingAdmin;
  }

  /**
   * The only administrator who could still *sign in*.
   *
   * The acting admin is banned here, and that is what makes the "last admin"
   * refusal reachable at all: with the self-deletion refusal checked first, an
   * acting admin who is themselves usable always remains behind, so no set of
   * ids can empty the instance of administrators. A ban is the one state that
   * separates "has the role" from "can administer" -- Better Auth refuses to
   * create a session for a banned user (`session.create.before` in
   * `plugins/admin/admin.mjs`) while leaving an already-issued session working,
   * which is exactly the situation modelled here.
   */
  async function onlyOtherAdminId(): Promise<string> {
    const actor = await currentAdminId();
    const other = await seedUser({ email: "other-admin@example.com", role: ADMIN_ROLE });
    execute("UPDATE users SET banned = 1, ban_reason = 'by hand' WHERE id = ?", actor);
    return other;
  }

  async function someNonAdminId(): Promise<string> {
    await currentAdminId();
    return seedUser({ email: "member@example.com", firstName: "Grace", lastName: "Hopper" });
  }

  beforeEach(async () => {
    vi.resetModules();
    requestHeaders.current = new Headers();
    cookieJar.clear();
    actingAdmin = undefined;

    const stamp = `${process.pid}-${Math.random().toString(36).slice(2)}`;
    dbPath = path.join(os.tmpdir(), `yana-users-${stamp}.db`);
    mediaPath = fs.mkdtempSync(path.join(os.tmpdir(), `yana-users-media-${stamp}-`));
    applyMigrationsAt(dbPath);
    process.env.DATABASE_PATH = dbPath;
    process.env.MEDIA_PATH = mediaPath;
    // Set before the import: Better Auth reads it while building its context.
    process.env.BETTER_AUTH_SECRET = "test-secret-not-used-outside-this-file-0123456789";

    ({ auth, createUserWithPassword } = await import("@/lib/auth/server"));
    actions = await import("./actions");
    queries = await import("./queries");
    client = await import("@/lib/db/client");
    schema = await import("@/lib/db/schema");
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
   * The catalog-parity test compares the two catalogs to each other and nothing
   * more; it cannot know that an action emits a key neither defines, which
   * would render the raw dotted path into a toast.
   */
  function usersMessage(key: string | undefined): unknown {
    if (!key) return undefined;
    return key
      .split(".")
      .reduce<unknown>(
        (node, part) => (node as Record<string, unknown> | undefined)?.[part],
        en.users,
      );
  }

  const LIST_DEFAULTS: ListParams = {
    q: "",
    page: 1,
    pageSize: 25,
    sort: "",
    dir: "asc",
    filters: {},
  };

  function listParams(overrides: Partial<ListParams> = {}): ListParams {
    return { ...LIST_DEFAULTS, ...overrides };
  }

  function seedFeed(userId: string, name: string): number {
    return client.writeTransaction(
      (tx) =>
        tx.insert(schema.feeds).values({ name, userId }).returning({ id: schema.feeds.id }).get()
          .id,
    );
  }

  function seedArticle(feedId: number, name: string): void {
    client.writeTransaction((tx) => {
      tx.insert(schema.articles)
        .values({ name, identifier: `${name}-id`, date: new Date(), feedId })
        .run();
    });
  }

  function seedTag(userId: string, name: string): void {
    client.writeTransaction((tx) => {
      tx.insert(schema.tags).values({ name, userId }).run();
    });
  }

  describe("listUsers", () => {
    it("pages in SQL and reports the unpaged total", async () => {
      await currentAdminId();
      for (let index = 0; index < 7; index++) {
        await seedUser({ email: `member-${index}@example.com` });
      }

      const page = await queries.listUsers(listParams({ pageSize: 3, page: 2 }));

      expect(page.rows).toHaveLength(3);
      // 7 members + the acting admin.
      expect(page.total).toBe(8);
      const last = await queries.listUsers(listParams({ pageSize: 3, page: 3 }));
      expect(last.rows).toHaveLength(2);
      // Pages do not overlap, so the ordering is total, not merely sorted.
      const ids = new Set([...page.rows, ...last.rows].map((row) => row.id));
      expect(ids.size).toBe(5);
    });

    it("carries only the columns the list renders", async () => {
      await currentAdminId();

      const { rows } = await queries.listUsers(listParams());

      // The ban columns and emailVerified are not the table's business, and a
      // row handed to a client component is serialized into the RSC payload of
      // every page that renders it.
      expect(Object.keys(rows[0]).sort()).toEqual(
        ["createdAt", "email", "firstName", "id", "image", "lastName", "name", "role"].sort(),
      );
    });

    it("searches the address and both name columns, case-insensitively", async () => {
      await currentAdminId();
      await seedUser({ email: "grace@example.com", firstName: "Grace", lastName: "Hopper" });
      await seedUser({ email: "katherine@example.com", firstName: "Katherine" });

      expect(
        (await queries.listUsers(listParams({ q: "HOPPER" }))).rows.map((r) => r.email),
      ).toEqual(["grace@example.com"]);
      expect(
        (await queries.listUsers(listParams({ q: "katherine@" }))).rows.map((r) => r.email),
      ).toEqual(["katherine@example.com"]);
      expect((await queries.listUsers(listParams({ q: "ada" }))).rows.map((r) => r.email)).toEqual([
        ADMIN.email,
      ]);
    });

    it("treats a LIKE wildcard in the query as a literal character", async () => {
      // Otherwise "%" matches everybody and the operator is told it is a search.
      await currentAdminId();
      await seedUser({ email: "percent%sign@example.com" });

      expect((await queries.listUsers(listParams({ q: "%" }))).rows.map((r) => r.email)).toEqual([
        "percent%sign@example.com",
      ]);
      expect((await queries.listUsers(listParams({ q: "_" }))).rows).toEqual([]);
    });

    /**
     * The role filter has to agree with `isAdminRole()` exactly, including on
     * the values that make a naive `role = 'admin'` wrong: a comma list is an
     * administrator to Better Auth, and "administrator" merely *contains* the
     * word. Asserted against the predicate itself rather than against a
     * hand-written expectation, so the two cannot drift.
     */
    const ROLE_SAMPLES = [
      "admin",
      "user",
      "user,admin",
      "admin,user",
      "user, admin",
      "administrator",
      "superadmin",
      "ADMIN",
      "",
      "admin,admin",
    ];

    async function seedEveryRole(): Promise<void> {
      await currentAdminId();
      for (const [index, role] of ROLE_SAMPLES.entries()) {
        await seedUser({ email: `role-${index}@example.com`, role });
      }
    }

    it("filters on admin authority the way isAdminRole() defines it", async () => {
      await seedEveryRole();

      const everyone = await queries.listUsers(listParams({ pageSize: 100 }));
      const admins = await queries.listUsers(
        listParams({ pageSize: 100, filters: { role: "admin" } }),
      );
      const standard = await queries.listUsers(
        listParams({ pageSize: 100, filters: { role: "standard" } }),
      );

      const emailsWhere = (predicate: (role: string) => boolean) =>
        everyone.rows
          .filter((row) => predicate(row.role))
          .map((row) => row.email)
          .sort();

      expect(admins.rows.map((row) => row.email).sort()).toEqual(emailsWhere(isAdminRole));
      expect(standard.rows.map((row) => row.email).sort()).toEqual(
        emailsWhere((role) => !isAdminRole(role)),
      );
      // The two halves partition the table -- no row is both or neither.
      expect(admins.total + standard.total).toBe(everyone.total);
      expect(admins.total).toBeGreaterThan(1);
      expect(standard.total).toBeGreaterThan(1);
    });

    it("ignores an empty role filter rather than matching an empty role", async () => {
      await seedEveryRole();

      const everyone = await queries.listUsers(listParams({ pageSize: 100 }));
      const unfiltered = await queries.listUsers(
        listParams({ pageSize: 100, filters: { role: "" } }),
      );

      expect(unfiltered.total).toBe(everyone.total);
    });

    it("sorts on a whitelisted column and ignores anything else", async () => {
      await currentAdminId();
      await seedUser({ email: "aaron@example.com" });
      await seedUser({ email: "zoe@example.com" });

      const ascending = await queries.listUsers(listParams({ sort: "email", dir: "asc" }));
      const descending = await queries.listUsers(listParams({ sort: "email", dir: "desc" }));
      expect(ascending.rows.map((row) => row.email)).toEqual([
        "aaron@example.com",
        ADMIN.email,
        "zoe@example.com",
      ]);
      expect(descending.rows.map((row) => row.email)).toEqual(
        [...ascending.rows].reverse().map((row) => row.email),
      );

      // A crafted `sort` must not reach the query builder: it falls back to the
      // default ordering rather than injecting or throwing.
      const crafted = await queries.listUsers(listParams({ sort: "role; DROP TABLE users" }));
      const fallback = await queries.listUsers(listParams());
      expect(crafted.rows.map((row) => row.email)).toEqual(fallback.rows.map((row) => row.email));
      expect(crafted.total).toBe(3);
    });

    it("breaks a tie on the id, so two pages cannot show the same row", async () => {
      // `createdAt` has one-second resolution, so several users provisioned in
      // the same second tie on the default sort. Without a tie-breaker SQLite
      // is free to order them differently for each LIMIT/OFFSET, which shows
      // one row on both pages and hides another entirely.
      await currentAdminId();
      for (let index = 0; index < 3; index++) {
        await seedUser({ email: `tied-${index}@example.com` });
      }
      execute("UPDATE users SET created_at = 1700000000");

      const first = await queries.listUsers(listParams({ pageSize: 2, page: 1 }));
      const second = await queries.listUsers(listParams({ pageSize: 2, page: 2 }));

      const seen = [...first.rows, ...second.rows].map((row) => row.id);
      expect(new Set(seen).size).toBe(4);
      // Code-unit order, which is SQLite's BINARY collation for these ids --
      // `localeCompare` would disagree about case and prove nothing.
      expect([...seen].sort((a, b) => (a < b ? -1 : 1))).toEqual(seen);
    });

    it("is refused to a signed-in non-admin", async () => {
      await currentAdminId();
      await seedUser({ email: "member@example.com" });
      requestAs(await signInCookie(auth, { email: "member@example.com", password: PASSWORD }));

      await expect(queries.listUsers(listParams())).rejects.toThrow();
    });
  });

  describe("getUser", () => {
    it("reads one row and answers null for an unknown id", async () => {
      await currentAdminId();
      const id = await someNonAdminId();

      expect(await queries.getUser(id)).toMatchObject({ id, email: "member@example.com" });
      expect(await queries.getUser("nobody")).toBe(null);
    });
  });

  describe("userImpact", () => {
    it("counts feeds, tags and the articles that hang off those feeds", async () => {
      const admin = await currentAdminId();
      const member = await someNonAdminId();

      const theirs = seedFeed(member, "Theirs");
      seedArticle(theirs, "first");
      seedArticle(theirs, "second");
      seedTag(member, "news");
      // The acting admin's own data must not be counted.
      const mine = seedFeed(admin, "Mine");
      seedArticle(mine, "not counted");
      seedTag(admin, "mine");

      // Articles have no user column: they are owned transitively, through the
      // feed, so this has to be a join rather than a where.
      expect(await actions.userImpact([member])).toEqual({ feeds: 1, tags: 1, articles: 2 });
      expect(await actions.userImpact([])).toEqual({ feeds: 0, tags: 0, articles: 0 });
    });

    it("is refused to a signed-in non-admin", async () => {
      await currentAdminId();
      const member = await someNonAdminId();
      requestAs(await signInCookie(auth, { email: "member@example.com", password: PASSWORD }));

      await expect(actions.userImpact([member])).rejects.toThrow();
    });
  });

  describe("createUser", () => {
    it("creates an account that can sign in and has a settings row", async () => {
      await currentAdminId();

      const result = await actions.createUser({
        email: "new@example.com",
        password: "a brand new password",
        firstName: "Katherine",
        lastName: "Johnson",
        role: queries.STANDARD_ROLE,
      });

      expect(result.ok).toBe(true);
      expect(result.id).toBeTypeOf("string");
      // A user with no user_settings row meets the error boundary on /settings
      // forever -- getSettings() throws and is deliberately not self-healing.
      expect(
        one<{ count: number }>(
          "SELECT COUNT(*) AS count FROM user_settings WHERE user_id = ?",
          result.id,
        ).count,
      ).toBe(1);
      // The display name Better Auth shows in the passkey chooser moves with
      // the two name columns.
      expect(one<{ name: string }>("SELECT name FROM users WHERE id = ?", result.id).name).toBe(
        "Katherine Johnson",
      );
      await expect(
        signInCookie(auth, { email: "new@example.com", password: "a brand new password" }),
      ).resolves.toBeTypeOf("string");
    });

    it("can create an administrator", async () => {
      await currentAdminId();

      const result = await actions.createUser({
        email: "second-admin@example.com",
        password: "a brand new password",
        firstName: "",
        lastName: "",
        role: "admin",
      });

      expect(result.ok).toBe(true);
      expect(
        isAdminRole(one<{ role: string }>("SELECT role FROM users WHERE id = ?", result.id).role),
      ).toBe(true);
    });

    it("refuses an address that is already taken, and creates nothing", async () => {
      await currentAdminId();

      const result = await actions.createUser({
        email: ADMIN.email,
        password: "a brand new password",
        firstName: "",
        lastName: "",
        role: queries.STANDARD_ROLE,
      });

      expect(result).toMatchObject({ ok: false, errorKey: "emailTaken" });
      expect(usersMessage(result.errorKey)).toBeTypeOf("string");
      expect(one<{ count: number }>("SELECT COUNT(*) AS count FROM users").count).toBe(1);
    });

    it("reports a bad address, a short password and an unknown role as catalog keys", async () => {
      await currentAdminId();
      const base = {
        email: "fine@example.com",
        password: "a brand new password",
        firstName: "",
        lastName: "",
        role: queries.STANDARD_ROLE,
      };

      const badEmail = await actions.createUser({ ...base, email: "not-an-address" });
      const shortPassword = await actions.createUser({ ...base, password: "short" });
      const badRole = await actions.createUser({ ...base, role: "root" });

      expect(badEmail.errorKey).toBe("emailInvalid");
      expect(shortPassword.errorKey).toBe("passwordTooShort");
      expect(badRole.errorKey).toBe("roleInvalid");
      for (const result of [badEmail, shortPassword, badRole]) {
        expect(result.ok).toBe(false);
        expect(usersMessage(result.errorKey)).toBeTypeOf("string");
      }
      expect(one<{ count: number }>("SELECT COUNT(*) AS count FROM users").count).toBe(1);
    });

    it("is refused to a signed-in non-admin", async () => {
      await currentAdminId();
      const member = await someNonAdminId();
      requestAs(await signInCookie(auth, { email: "member@example.com", password: PASSWORD }));

      await expect(
        actions.createUser({
          email: "sneaky@example.com",
          password: "a brand new password",
          firstName: "",
          lastName: "",
          role: "admin",
        }),
      ).rejects.toThrow();
      expect(one<{ count: number }>("SELECT COUNT(*) AS count FROM users").count).toBe(2);
      expect(member).toBeTypeOf("string");
    });
  });

  describe("updateUser", () => {
    it("writes the columns and the derived display name", async () => {
      await currentAdminId();
      const member = await someNonAdminId();

      const result = await actions.updateUser(member, {
        email: "grace@example.com",
        firstName: "Grace",
        lastName: "Hopper",
        role: "admin",
      });

      expect(result).toEqual({ ok: true });
      expect(
        one<Record<string, unknown>>("SELECT * FROM users WHERE id = ?", member),
      ).toMatchObject({
        email: "grace@example.com",
        first_name: "Grace",
        last_name: "Hopper",
        name: "Grace Hopper",
        role: "admin",
      });
    });

    it("refuses to demote the acting admin out of the admin role", async () => {
      // An immediate, irreversible self-lockout: the users tab is admin-only,
      // so the demotion removes the only route back to it.
      const admin = await currentAdminId();

      const result = await actions.updateUser(admin, {
        email: ADMIN.email,
        firstName: "Ada",
        lastName: "",
        role: queries.STANDARD_ROLE,
      });

      expect(result).toEqual({ ok: false, errorKey: "demoteSelf" });
      expect(usersMessage(result.errorKey)).toBeTypeOf("string");
      expect(
        isAdminRole(one<{ role: string }>("SELECT role FROM users WHERE id = ?", admin).role),
      ).toBe(true);
    });

    it("rejects an email already taken by another user", async () => {
      await currentAdminId();
      const member = await someNonAdminId();

      const result = await actions.updateUser(member, {
        email: ADMIN.email,
        firstName: "Grace",
        lastName: "Hopper",
        role: queries.STANDARD_ROLE,
      });

      expect(result).toEqual({ ok: false, errorKey: "emailTaken" });
      expect(usersMessage(result.errorKey)).toBeTypeOf("string");
      expect(one<{ email: string }>("SELECT email FROM users WHERE id = ?", member).email).toBe(
        "member@example.com",
      );
    });

    it("reports an id that no longer exists rather than claiming success", async () => {
      await currentAdminId();

      const result = await actions.updateUser("nobody", {
        email: "nobody@example.com",
        firstName: "",
        lastName: "",
        role: queries.STANDARD_ROLE,
      });

      expect(result).toEqual({ ok: false, errorKey: "notFound" });
      expect(usersMessage(result.errorKey)).toBeTypeOf("string");
    });

    it("makes an edit of the admin's own row visible to the very next currentUser()", async () => {
      // The five-minute session cookie cache hides a direct column write from
      // every later render, exactly as it does on /account -- so an admin who
      // renames themselves here must get refreshSession() too.
      const admin = await currentAdminId();
      const session = await import("@/lib/auth/session");
      expect((await session.currentUser())?.firstName).toBe("Ada");

      await actions.updateUser(admin, {
        email: ADMIN.email,
        firstName: "Augusta",
        lastName: "King",
        role: ADMIN_ROLE,
      });
      requestAs(nextRequestCookies());

      expect((await session.currentUser())?.firstName).toBe("Augusta");
    });

    it("is refused to a signed-in non-admin", async () => {
      await currentAdminId();
      const member = await someNonAdminId();
      requestAs(await signInCookie(auth, { email: "member@example.com", password: PASSWORD }));

      await expect(
        actions.updateUser(member, {
          email: "member@example.com",
          firstName: "Grace",
          lastName: "Hopper",
          role: "admin",
        }),
      ).rejects.toThrow();
      expect(
        isAdminRole(one<{ role: string }>("SELECT role FROM users WHERE id = ?", member).role),
      ).toBe(false);
    });
  });

  describe("deleteUsers", () => {
    it("refuses to delete the acting admin", async () => {
      // Self-deletion is an immediate lockout.
      const result = await actions.deleteUsers([await currentAdminId()]);

      expect(result).toMatchObject({ ok: false, errorKey: "deleteSelf", deleted: 0 });
      expect(usersMessage(result.errorKey)).toBeTypeOf("string");
    });

    it("refuses to delete the last admin", async () => {
      const result = await actions.deleteUsers([await onlyOtherAdminId()]);

      expect(result).toMatchObject({ ok: false, errorKey: "lastAdmin", deleted: 0 });
      expect(usersMessage(result.errorKey)).toBeTypeOf("string");
      expect(one<{ count: number }>("SELECT COUNT(*) AS count FROM users").count).toBe(2);
    });

    it("allows deleting an admin while another usable one remains", async () => {
      // The control for the refusal above: without it, a guard that refused
      // every admin deletion would pass and the feature would be broken.
      await currentAdminId();
      const other = await seedUser({ email: "other-admin@example.com", role: "user,admin" });

      expect(await actions.deleteUsers([other])).toMatchObject({ ok: true, deleted: 1 });
    });

    it("reports how many rows it deleted", async () => {
      const result = await actions.deleteUsers([await someNonAdminId()]);

      expect(result).toMatchObject({ ok: true, deleted: 1 });
    });

    it("refuses the whole set when one id is refused", async () => {
      const admin = await currentAdminId();
      const member = await someNonAdminId();

      const result = await actions.deleteUsers([member, admin]);

      expect(result).toMatchObject({ ok: false, errorKey: "deleteSelf", deleted: 0 });
      expect(one<{ count: number }>("SELECT COUNT(*) AS count FROM users").count).toBe(2);
    });

    it("refuses an empty selection instead of reporting a successful no-op", async () => {
      await currentAdminId();

      const result = await actions.deleteUsers([]);

      expect(result).toMatchObject({ ok: false, errorKey: "noneSelected", deleted: 0 });
      expect(usersMessage(result.errorKey)).toBeTypeOf("string");
    });

    it("cascades to feeds, tags, articles and settings", async () => {
      // foreign_keys = ON is what makes this real; without the PRAGMA the rows
      // would be orphaned silently.
      await currentAdminId();
      const member = await someNonAdminId();
      const feed = seedFeed(member, "Theirs");
      seedArticle(feed, "first");
      seedTag(member, "news");
      client.writeTransaction((tx) => {
        tx.insert(schema.userSettings).values({ userId: member }).run();
      });
      // A live session of theirs, so "they are signed out by the delete" is a
      // real assertion rather than a vacuous one.
      await signInCookie(auth, { email: "member@example.com", password: PASSWORD });
      requestAs(adminCookie);

      expect(await actions.deleteUsers([member])).toMatchObject({ ok: true, deleted: 1 });

      // Articles hang off the feed, not off the user, so they go only if the
      // cascade actually chained twice.
      expect(all<unknown>("SELECT * FROM articles")).toEqual([]);
      for (const table of ["feeds", "tags", "user_settings", "accounts", "sessions"]) {
        const remaining = one<{ count: number }>(
          `SELECT COUNT(*) AS count FROM ${table} WHERE user_id = ?`,
          member,
        ).count;
        expect(remaining, table).toBe(0);
      }
      // ...and the acting admin's own rows are untouched.
      expect(all<unknown>("SELECT * FROM sessions").length).toBe(1);
    });

    it("unlinks the deleted user's avatar file", async () => {
      // The cascade cannot reach the filesystem, and the media route serves
      // what is on disk without ever reading users.image -- so nulling or
      // deleting the column leaves the picture behind. Same asymmetry
      // removeAvatar() exists to close on /account.
      await currentAdminId();
      const member = await someNonAdminId();
      const storage = await import("@/lib/avatar-storage");
      const file = storage.avatarFilePath(member) as string;
      expect(file).toBeTypeOf("string");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, "not really a webp");

      expect(await actions.deleteUsers([member])).toMatchObject({ ok: true, deleted: 1 });

      expect(fs.existsSync(file)).toBe(false);
    });

    it("is refused to a signed-in non-admin", async () => {
      await currentAdminId();
      const member = await someNonAdminId();
      const victim = await seedUser({ email: "victim@example.com" });
      requestAs(await signInCookie(auth, { email: "member@example.com", password: PASSWORD }));

      await expect(actions.deleteUsers([victim])).rejects.toThrow();
      expect(one<{ count: number }>("SELECT COUNT(*) AS count FROM users").count).toBe(3);
      expect(member).toBeTypeOf("string");
    });
  });
});
