import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { signInCookie } from "@/lib/auth/test-support";
import type { ListParams } from "@/lib/crud/params";
import { applyMigrationsAt } from "@/lib/db/test-support";

/**
 * Real-database tests for the gated job reads `/jobs` and `/jobs/[id]` call,
 * in the style of `./actions.test.ts`: a temp SQLite file per test, migrated
 * by the same `applyMigrations()` the container runs, and every actor signed
 * in through the real `/sign-in/email`. No driver mocks.
 *
 * **These are the authorization tests for the job list, not a convenience
 * wrapper's unit tests.** `/jobs` and `/jobs/[id]` used to `await
 * requireUserFreshRole()` in the page body and derive the owner filter there;
 * the instant-render migration removed that await, so the filter has to be
 * decided *here* or a non-admin's page would read every user's jobs. Each
 * case below is one half of that rule: a non-admin sees only `jobs.userId =
 * their own id`, an admin sees every row including the ownerless `retention`
 * kind, and the role behind that decision is never read from the five-minute
 * session cookie cache.
 *
 * Only Next's *request scope* is stubbed (`next/headers`, which supplies the
 * cookies `requireUserFreshRole()` reads).
 */
const { requestHeaders, cookieJar } = vi.hoisted(() => ({
  requestHeaders: { current: new Headers() },
  cookieJar: new Map<string, string>(),
}));

vi.mock("next/headers", async () =>
  (await import("@/test/next-headers")).nextHeadersStub(requestHeaders, cookieJar),
);

const PASSWORD = "correct horse battery staple";

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

describe("src/lib/jobs/queries", () => {
  let dbPath: string;
  let queries: typeof import("./queries");
  let queue: typeof import("./queue");
  let auth: typeof import("@/lib/auth/server").auth;
  let createUserWithPassword: typeof import("@/lib/auth/server").createUserWithPassword;
  let client: typeof import("@/lib/db/client");
  let schema: typeof import("@/lib/db/schema");

  function raw(db: unknown): Database.Database {
    return (db as { $client: Database.Database }).$client;
  }

  function requestAs(cookie: string): void {
    requestHeaders.current = new Headers({ cookie });
  }

  async function seedUser(email: string, role = "user"): Promise<string> {
    const user = await createUserWithPassword({
      email,
      password: PASSWORD,
      firstName: "",
      lastName: "",
      role,
    });
    return user.id;
  }

  async function signInAs(email: string): Promise<void> {
    requestAs(await signInCookie(auth, { email, password: PASSWORD }));
    cookieJar.clear();
  }

  /** The three rows every case below reasons about: mine, theirs, nobody's. */
  async function seedThreeJobs(): Promise<{
    member: string;
    other: string;
    mine: number;
    theirs: number;
    ownerless: number;
  }> {
    const member = await seedUser("member@example.com");
    const other = await seedUser("other@example.com");
    const mine = queue.enqueue("aggregate", { feedId: 1 }, { userId: member });
    const theirs = queue.enqueue("aggregate", { feedId: 2 }, { userId: other });
    // `retention` runs once per boot across every user and owns none of them
    // individually -- `jobs.userId` is null for that kind, and only an admin
    // may see it. See the `jobs.userId` bullet in CLAUDE.md.
    const ownerless = queue.enqueue("retention", {});
    return { member, other, mine, theirs, ownerless };
  }

  beforeEach(async () => {
    vi.resetModules();
    requestHeaders.current = new Headers();
    cookieJar.clear();

    const stamp = `${process.pid}-${Math.random().toString(36).slice(2)}`;
    dbPath = path.join(os.tmpdir(), `yana-jobs-queries-${stamp}.db`);
    applyMigrationsAt(dbPath);
    process.env.DATABASE_PATH = dbPath;
    // Set before the import: Better Auth reads it while building its context.
    process.env.BETTER_AUTH_SECRET = "test-secret-not-used-outside-this-file-0123456789";

    ({ auth, createUserWithPassword } = await import("@/lib/auth/server"));
    queries = await import("./queries");
    queue = await import("./queue");
    client = await import("@/lib/db/client");
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

  describe("listJobsForCurrentUser", () => {
    it("gives a non-admin only their own rows -- never another user's, never an ownerless one", async () => {
      const { mine } = await seedThreeJobs();
      await signInAs("member@example.com");

      const page = await queries.listJobsForCurrentUser(listParams());

      expect(page.jobs.map((job) => job.id)).toEqual([mine]);
      // The count the pagination renders has to be scoped too: a total of 3
      // over a single visible row would leak how many jobs other users have.
      expect(page.total).toBe(1);
      // Only an admin sees jobs across every user, so only an admin gets the
      // column that says whose.
      expect(page.showOwner).toBe(false);
    });

    it("gives a non-admin who owns nothing an empty list", async () => {
      await seedThreeJobs();
      await seedUser("nothing@example.com");
      await signInAs("nothing@example.com");

      const page = await queries.listJobsForCurrentUser(listParams());

      expect(page.jobs).toEqual([]);
      expect(page.total).toBe(0);
    });

    it("gives an admin every row, ownerless ones included", async () => {
      const { mine, theirs, ownerless } = await seedThreeJobs();
      await seedUser("admin@example.com", "admin");
      await signInAs("admin@example.com");

      const page = await queries.listJobsForCurrentUser(listParams());

      expect(new Set(page.jobs.map((job) => job.id))).toEqual(new Set([mine, theirs, ownerless]));
      expect(page.total).toBe(3);
      expect(page.showOwner).toBe(true);
    });

    it("re-reads the role, so a demoted admin loses cross-user visibility at once", async () => {
      // The correctness heart of the gate: `session.cookieCache` serves the
      // whole user object -- `role` included -- out of a signed cookie for
      // five minutes with no database read, so an admin demoted a moment ago
      // would keep seeing every user's jobs until it expired. This is what
      // `requireUserFreshRole()`'s `disableCookieCache: true` buys, and a test
      // that signed in as an admin and never re-checked would pass without it.
      const { mine } = await seedThreeJobs();
      const adminId = await seedUser("admin@example.com", "admin");
      await signInAs("admin@example.com");
      expect((await queries.listJobsForCurrentUser(listParams())).total).toBe(3);

      client.writeTransaction((tx) => {
        tx.update(schema.users).set({ role: "user" }).where(eq(schema.users.id, adminId)).run();
      });

      const page = await queries.listJobsForCurrentUser(listParams());
      // Demoted, and owning no jobs of their own -- so an empty list, not the
      // three rows the still-valid cookie cache would have vouched for.
      expect(page.jobs.map((job) => job.id)).not.toContain(mine);
      expect(page.jobs).toEqual([]);
      expect(page.showOwner).toBe(false);
    });

    it("redirects a caller with no session to the login page", async () => {
      await seedThreeJobs();
      requestHeaders.current = new Headers();

      await expect(queries.listJobsForCurrentUser(listParams())).rejects.toThrow(/NEXT_REDIRECT/);
    });
  });

  describe("getJobForCurrentUser", () => {
    it("answers a non-admin's own job, and null for another user's or an ownerless one", async () => {
      const { mine, theirs, ownerless } = await seedThreeJobs();
      await signInAs("member@example.com");

      expect(await queries.getJobForCurrentUser(mine)).toMatchObject({ id: mine });
      // Indistinguishable from an id that does not exist: "not yours" and "no
      // such job" must answer the same way, or the difference enumerates other
      // users' job ids.
      expect(await queries.getJobForCurrentUser(theirs)).toBe(null);
      expect(await queries.getJobForCurrentUser(ownerless)).toBe(null);
      expect(await queries.getJobForCurrentUser(999_999)).toBe(null);
    });

    it("answers an admin any job, ownerless ones included", async () => {
      const { theirs, ownerless } = await seedThreeJobs();
      await seedUser("admin@example.com", "admin");
      await signInAs("admin@example.com");

      expect(await queries.getJobForCurrentUser(theirs)).toMatchObject({ id: theirs });
      expect(await queries.getJobForCurrentUser(ownerless)).toMatchObject({ id: ownerless });
    });

    it("re-reads the role, so a demoted admin can no longer read another user's job", async () => {
      const { theirs } = await seedThreeJobs();
      const adminId = await seedUser("admin@example.com", "admin");
      await signInAs("admin@example.com");
      expect(await queries.getJobForCurrentUser(theirs)).toMatchObject({ id: theirs });

      client.writeTransaction((tx) => {
        tx.update(schema.users).set({ role: "user" }).where(eq(schema.users.id, adminId)).run();
      });

      expect(await queries.getJobForCurrentUser(theirs)).toBe(null);
    });
  });
});
