import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyMigrationsAt } from "@/lib/db/test-support";

/**
 * Every `/admin/*` path the **installed** `admin()` plugin declares, read off
 * its own source rather than copied.
 *
 * `./server` cannot be imported at module scope here -- the suite sets
 * `DATABASE_PATH` and `BETTER_AUTH_SECRET` before each dynamic import, and one
 * test asserts the module opens no database at import time -- so the endpoint
 * list is derived independently and the config's copy is compared against it in
 * its own test below.
 */
const DECLARED_ADMIN_PATHS: string[] = [
  ...new Set(
    [
      ...fs
        .readFileSync(
          path.join(
            path.resolve(import.meta.dirname, "../../.."),
            "node_modules/better-auth/dist/plugins/admin/routes.mjs",
          ),
          "utf8",
        )
        .matchAll(/createAuthEndpoint\(\s*"(\/admin\/[a-z-]+)"/g),
    ].map((match) => match[1]),
  ),
].toSorted();

const DECLARED_ONE_TIME_TOKEN_PATHS: string[] = [
  ...new Set(
    [
      ...fs
        .readFileSync(
          path.join(
            path.resolve(import.meta.dirname, "../../.."),
            "node_modules/better-auth/dist/plugins/one-time-token/index.mjs",
          ),
          "utf8",
        )
        .matchAll(/createAuthEndpoint\(\s*"(\/one-time-token\/[a-z-]+)"/g),
    ].map((match) => match[1]),
  ),
].toSorted();

/**
 * Real-database test, no driver mocks -- the convention in CLAUDE.md, and here
 * it is the only kind of test worth writing. Two things are under test and
 * neither is visible to `tsc`:
 *
 * 1. **A mapping.** Better Auth's singular model names (`user`, `session`,
 *    `account`) resolved onto this repository's plural Drizzle exports by
 *    `usePlural`, and its camelCase field names resolved onto Drizzle property
 *    names that happen to match. The adapter indexes the table object with a
 *    computed string, so a wrong `usePlural`, a renamed property
 *    (`credentialId` for `credentialID`) or a column Better Auth writes that
 *    the table lacks all compile cleanly and fail at the first request, with
 *    errors that read like data corruption.
 * 2. **A policy.** There is no self-registration path: `disableSignUp` closes
 *    /api/auth/sign-up/email, and `role` is server-owned. Both are one config
 *    line away from silently reopening, and neither would fail a build.
 *
 * Assertions read the file back through raw SQL rather than through Drizzle, so
 * a mistake in the schema definition cannot mask itself on the way out.
 */
describe("the Better Auth instance", () => {
  let dbPath: string;
  let auth: typeof import("./server").auth;
  let createUserWithPassword: typeof import("./server").createUserWithPassword;
  let route: typeof import("@/app/api/auth/[...all]/route");
  let client: typeof import("@/lib/db/client");

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

  /** Seed an account the only way one can now exist, and sign in as it. */
  async function seedAndSignIn(): Promise<{ cookie: string; id: string }> {
    const user = await createUserWithPassword({
      email: "member@example.com",
      password: "correct horse battery staple",
      name: "Member",
    });
    const response = await auth.api.signInEmail({
      body: { email: "member@example.com", password: "correct horse battery staple" },
      asResponse: true,
    });
    expect(response.status).toBe(200);
    return { cookie: response.headers.get("set-cookie") ?? "", id: user.id };
  }

  beforeEach(async () => {
    vi.resetModules();
    dbPath = path.join(
      os.tmpdir(),
      `yana-auth-${process.pid}-${Math.random().toString(36).slice(2)}.db`,
    );
    applyMigrationsAt(dbPath);
    process.env.DATABASE_PATH = dbPath;
    // Set before the import: Better Auth reads it while building its context.
    process.env.BETTER_AUTH_SECRET = "test-secret-not-used-outside-this-file-0123456789";
    ({ auth, createUserWithPassword } = await import("./server"));
    route = await import("@/app/api/auth/[...all]/route");
    client = await import("@/lib/db/client");
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

  it("provisions a user into phase 2's users table and the new satellites", async () => {
    const user = await createUserWithPassword({
      email: "someone@example.com",
      password: "correct horse battery staple",
      name: "Some One",
      firstName: "Some",
      lastName: "One",
      role: "admin",
    });

    const row = query<Record<string, unknown>>("SELECT * FROM users WHERE id = ?", user.id);
    const account = query<Record<string, unknown>>(
      "SELECT * FROM accounts WHERE user_id = ?",
      user.id,
    );

    // The columns phase 2 declared plus the four the admin plugin added,
    // populated without a single `fields` mapping entry -- which is the claim
    // that `usePlural` alone is enough.
    expect(row).toMatchObject({
      email: "someone@example.com",
      name: "Some One",
      email_verified: 0,
      first_name: "Some",
      last_name: "One",
      role: "admin",
      banned: 0,
      ban_reason: null,
      ban_expires: null,
    });
    expect(typeof row.created_at).toBe("number");
    expect(typeof row.updated_at).toBe("number");

    expect(account).toMatchObject({ provider_id: "credential", account_id: user.id });
    expect(account.password).not.toBe("correct horse battery staple");
  });

  it("defaults role to user, and stores a hash Better Auth can verify", async () => {
    // Sign-in is the assertion that matters: "not the plaintext" would pass for
    // any garbage. Only Better Auth's own scrypt verify proves the seam used
    // the same hashing path /sign-up/email would have.
    const { cookie, id } = await seedAndSignIn();

    expect(cookie).not.toBe("");
    expect(query<{ role: string }>("SELECT role FROM users WHERE id = ?", id).role).toBe("user");
  });

  it("refuses a public sign-up through the mounted route, and writes nothing", async () => {
    // Through the real route module, not just the config: what matters is that
    // the *endpoint* is shut. A self-hosted server with an open
    // /api/auth/sign-up/email hands an account to anyone who can reach it.
    const response = await route.POST(
      new Request("http://localhost:3000/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "intruder@example.com",
          password: "correct horse battery staple",
          name: "Intruder",
        }),
      }),
    );

    // The specific code, not just "a 400": a malformed-request 400 would pass a
    // bare status assertion while the endpoint was wide open to a well-formed
    // one.
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "EMAIL_PASSWORD_SIGN_UP_DISABLED" });
    expect(query<{ count: number }>("SELECT COUNT(*) AS count FROM users").count).toBe(0);
  });

  it("refuses to route /update-user at all, so users.image cannot be set over HTTP", async () => {
    // `image` is what makes this endpoint dangerous, and `input: false` cannot
    // reach it: `api/routes/update-user.mjs` destructures `name` and `image`
    // out of the body *before* parseUserInput(), and getFields(…, "input")
    // covers only additionalFields and plugin fields anyway. So the path is
    // closed instead, via `disabledPaths`. Without this, any signed-in
    // non-admin could point their avatar at an external URL that then fires
    // from every other user's browser -- an IP/user-agent/referrer beacon that
    // routes around the whole session-gated media route.
    //
    // Through the mounted route, not the config: `disabledPaths` is enforced in
    // the router's onRequest, so only an HTTP request exercises it.
    const { cookie, id } = await seedAndSignIn();

    const response = await route.POST(
      new Request("http://localhost:3000/api/auth/update-user", {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ image: "https://evil.example.com/track.gif" }),
      }),
    );

    expect(response.status).toBe(404);
    expect(query<{ image: string | null }>("SELECT image FROM users WHERE id = ?", id).image).toBe(
      null,
    );
  });

  /**
   * **Every endpoint the `admin()` plugin mounts answers 404, to an
   * administrator.**
   *
   * Signed in as a real admin, because that is the caller these routes were
   * written for -- a non-admin already gets a 403 from the plugin's own
   * middleware, so proving they are closed to one proves nothing. Driven
   * through the mounted route rather than `auth.api`, because `disabledPaths`
   * is enforced in the router's `onRequest` and nowhere else.
   */
  async function seedAdminAndSignIn(): Promise<{ cookie: string; id: string }> {
    const user = await createUserWithPassword({
      email: "boss@example.com",
      password: "correct horse battery staple",
      name: "Boss",
      role: "admin",
    });
    const response = await auth.api.signInEmail({
      body: { email: "boss@example.com", password: "correct horse battery staple" },
      asResponse: true,
    });
    expect(response.status).toBe(200);
    return { cookie: response.headers.get("set-cookie") ?? "", id: user.id };
  }

  it.each(DECLARED_ADMIN_PATHS)("refuses to route %s even for an admin", async (adminPath) => {
    const { cookie } = await seedAdminAndSignIn();

    const request = new Request(`http://localhost:3000/api/auth${adminPath}`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: "{}",
    });
    const response = await (adminPath === "/admin/get-user" || adminPath === "/admin/list-users"
      ? route.GET(
          new Request(`http://localhost:3000/api/auth${adminPath}`, { headers: { cookie } }),
        )
      : route.POST(request));

    expect(response.status).toBe(404);
  });

  it("names every admin endpoint the installed plugin declares", async () => {
    // The list in `./server` is hand-written because the plugin exports no
    // manifest of its paths, so it can go stale silently -- a better-auth
    // upgrade that adds an endpoint would mount it open, and nothing else here
    // would notice. `DECLARED_ADMIN_PATHS` is read off the library's own
    // source, which is where the paths are declared.
    const { ADMIN_PLUGIN_PATHS } = await import("./server");

    expect(ADMIN_PLUGIN_PATHS.toSorted()).toEqual(DECLARED_ADMIN_PATHS);
  });

  it.each(DECLARED_ONE_TIME_TOKEN_PATHS)("refuses to route %s", async (ottPath) => {
    const request = new Request(`http://localhost:3000/api/auth${ottPath}`, {
      method: ottPath === "/one-time-token/generate" ? "GET" : "POST",
      headers: { "content-type": "application/json" },
      body: ottPath === "/one-time-token/generate" ? undefined : "{}",
    });
    const response =
      ottPath === "/one-time-token/generate" ? await route.GET(request) : await route.POST(request);

    expect(response.status).toBe(404);
  });

  it("names every one-time-token endpoint the installed plugin declares", async () => {
    const { ONE_TIME_TOKEN_PLUGIN_PATHS } = await import("./server");

    expect(ONE_TIME_TOKEN_PLUGIN_PATHS.toSorted()).toEqual(DECLARED_ONE_TIME_TOKEN_PATHS);
  });

  it("cannot be talked into the role list that used to brick the next restart", async () => {
    // The review's live reproduction, in one call: /admin/set-role took an
    // arbitrary array with no validation (no custom `roles` map is configured,
    // so there is nothing to validate against) and wrote "user,admin". From
    // there the app and the plugin disagreed about who was an admin, and the
    // next boot tried to recreate admin@admin.com and died on
    // users_email_unique. See the bricking tests in ./bootstrap.test.ts.
    const { cookie, id } = await seedAdminAndSignIn();

    const response = await route.POST(
      new Request("http://localhost:3000/api/auth/admin/set-role", {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ userId: id, role: ["user", "admin"] }),
      }),
    );

    expect(response.status).toBe(404);
    expect(query<{ role: string }>("SELECT role FROM users WHERE id = ?", id).role).toBe("admin");
  });

  it("cannot create a user that would have no settings row", async () => {
    // /admin/create-user writes `users` and nothing else -- only
    // ensureAdminExists() writes user_settings -- and getSettings() throws by
    // design with no insert-if-absent fallback. So a user created this way
    // could sign in, use /account, and meet the error boundary on /settings
    // permanently. Closing the path is what fixes it; getSettings() keeps
    // throwing.
    const { cookie } = await seedAdminAndSignIn();

    const response = await route.POST(
      new Request("http://localhost:3000/api/auth/admin/create-user", {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({
          email: "ghost@example.com",
          password: "correct horse battery staple",
          name: "Ghost",
        }),
      }),
    );

    expect(response.status).toBe(404);
    expect(
      query<{ count: number }>(
        "SELECT COUNT(*) AS count FROM users WHERE email = 'ghost@example.com'",
      ).count,
    ).toBe(0);
  });

  it("still lets a server action write users.image, which is how task 6 sets it", async () => {
    // The other half of the check above: closing the path must not close the
    // capability. `disabledPaths` gates HTTP routing only, so application code
    // writing through writeTransaction() -- the convention every write here
    // follows -- is untouched.
    const { id } = await seedAndSignIn();
    const schema = await import("@/lib/db/schema");
    const { eq } = await import("drizzle-orm");

    client.writeTransaction((tx) => {
      tx.update(schema.users)
        .set({ image: `/media/avatars/${id}` })
        .where(eq(schema.users.id, id))
        .run();
    });

    expect(query<{ image: string }>("SELECT image FROM users WHERE id = ?", id).image).toBe(
      `/media/avatars/${id}`,
    );
  });

  it("refuses a role sent in a request body, on the API that could still take one", async () => {
    // /update-user is no longer routable (above), so this exercises the guard
    // one layer down: `auth.api.updateUser()` is the in-process call, which
    // skips the router and therefore skips `disabledPaths`. `input: false` on
    // the plugin's `role` field is what refuses it -- Better Auth throws
    // BAD_REQUEST rather than silently dropping the field (see `parseInputData`
    // in better-auth/dist/db/schema.mjs). Kept because that guard is what
    // protects `role` everywhere, including any future endpoint that reaches
    // parseUserInput().
    const { cookie, id } = await seedAndSignIn();

    const response = await auth.api.updateUser({
      body: { role: "admin" } as never,
      headers: new Headers({ cookie }),
      asResponse: true,
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "FIELD_NOT_ALLOWED" });
    expect(query<{ role: string }>("SELECT role FROM users WHERE id = ?", id).role).toBe("user");

    // Control: the same call with an allowed field succeeds. Without this the
    // test above would still pass if /update-user were broken outright, which
    // would prove nothing about `role`.
    const allowed = await auth.api.updateUser({
      body: { name: "Renamed" },
      headers: new Headers({ cookie }),
      asResponse: true,
    });

    expect(allowed.status).toBe(200);
    expect(query<{ name: string }>("SELECT name FROM users WHERE id = ?", id).name).toBe("Renamed");
  });

  it("round-trips the session cookie back to the signed-in user", async () => {
    const { cookie, id } = await seedAndSignIn();

    // Proves the sessions mapping in the direction the app actually uses it:
    // token lookup, not insert. A wrong column name here would have let the
    // provisioning test pass and every login fail.
    const session = await auth.api.getSession({ headers: new Headers({ cookie }) });

    expect(session?.user.id).toBe(id);
    expect(session?.user.email).toBe("member@example.com");
    expect(session?.user.role).toBe("user");
  });

  it("turns a failed initialisation into a failed request, not a dead worker", async () => {
    // Better Auth calls init() at import and stores the promise unawaited
    // (`createBetterAuth` in better-auth/dist/auth/base.mjs), so a rejection
    // there is an unhandled rejection at *module load* -- which under Node's
    // default --unhandled-rejections=throw can take a whole server worker down
    // instead of failing the one route that needs auth. `server.ts` attaches a
    // handler to auth.$context to prevent that.
    //
    // A malformed BETTER_AUTH_SECRETS is the cheapest real trigger: it throws
    // inside createAuthContext regardless of NODE_ENV, whereas the live case
    // (a missing secret under NODE_ENV=production) cannot be reproduced here --
    // validateSecret short-circuits on isTest(), and `nodeENV` is frozen at
    // import of better-auth's env module.
    //
    // This test also guards the fix by construction: delete the `.catch` in
    // server.ts and the rejection below becomes unhandled, which vitest itself
    // reports as a failure.
    vi.resetModules();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    process.env.BETTER_AUTH_SECRETS = "this-entry-has-no-version-prefix";

    try {
      const broken = await import("./server");
      // Let the rejection settle so the attached handler runs.
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(logged).toHaveBeenCalledWith(
        expect.stringContaining("Better Auth failed to initialise"),
        expect.anything(),
      );
      // The failure still reaches the caller -- it is suppressed as a process
      // event, not swallowed.
      await expect(broken.auth.api.getSession({ headers: new Headers() })).rejects.toThrow(
        /BETTER_AUTH_SECRETS/,
      );
    } finally {
      delete process.env.BETTER_AUTH_SECRETS;
      logged.mockRestore();
    }
  });

  it("says nothing about it during a production build, and still rejects", async () => {
    // `next build` imports every route's module graph in each of its seven
    // workers, so on a machine with no BETTER_AUTH_SECRET this printed the
    // warning above seven times per build -- about requests the build never
    // serves. A message that appears when nothing is wrong trains readers to
    // scroll past the one time it means something.
    //
    // Both halves are asserted: quiet, *and* the failure still reaches a
    // caller. Suppressing the log must not suppress the error, or the guard
    // becomes a way to hide a real misconfiguration.
    vi.resetModules();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    process.env.BETTER_AUTH_SECRETS = "this-entry-has-no-version-prefix";
    process.env.NEXT_PHASE = "phase-production-build";

    try {
      const broken = await import("./server");
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(logged).not.toHaveBeenCalled();
      await expect(broken.auth.api.getSession({ headers: new Headers() })).rejects.toThrow(
        /BETTER_AUTH_SECRETS/,
      );
    } finally {
      delete process.env.NEXT_PHASE;
      delete process.env.BETTER_AUTH_SECRETS;
      logged.mockRestore();
    }
  });

  it("does not open the database while the module is being imported", async () => {
    // `next build` imports every route's module graph, and `data/` does not
    // exist until the server's startup hook migrates it -- so an eager getDb() in
    // this module would create a database on the build machine. The proxy in
    // server.ts is what keeps it lazy; this is the test that would notice if
    // somebody "simplified" it back to `drizzleAdapter(getDb(), ...)`.
    vi.resetModules();
    const missing = path.join(os.tmpdir(), `yana-auth-never-${Date.now()}`, "nested", "yana.db");
    process.env.DATABASE_PATH = missing;

    try {
      await import("./server");
      expect(fs.existsSync(path.dirname(missing))).toBe(false);
    } finally {
      // `finally`, so a failed assertion cannot leak the bogus path into
      // afterEach, where getDb() would then open a second database.
      process.env.DATABASE_PATH = dbPath;
    }
  });
});
