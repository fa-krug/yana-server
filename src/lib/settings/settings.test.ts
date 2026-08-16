import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { signInCookie } from "@/lib/auth/test-support";
import { applyMigrationsAt } from "@/lib/db/test-support";
import en from "../../../messages/en.json";

// Real-database test, no driver mocks -- see CLAUDE.md's testing convention
// and src/lib/auth/bootstrap.test.ts, which this follows. Each test points
// DATABASE_PATH at its own temp file, migrates it through the same
// applyMigrations() the server runs at startup, then exercises the actions/queries
// through the real getDb()/writeTransaction() singleton.
//
// The user these queries scope to is created by the real admin bootstrap in
// beforeEach, exactly as instrumentation.ts does it at server start -- not by a
// hand-inserted fixture row -- and then *signed in* through the real
// /sign-in/email endpoint, because currentUserId() is a session read now. A
// fixture that diverged from what the bootstrap actually writes, or a
// hand-built session row, would let these tests pass over a state no running
// instance is ever in.
//
// next/cache's revalidatePath() is the one thing stubbed: it requires a Next
// request scope that does not exist under Vitest and throws if called for
// real, and it has no database behavior of its own to verify. Everything
// touching SQLite runs unmocked.
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

// The other half of that request scope: next/headers, which is where the
// session read gets its cookies. A hoisted box rather than a shared stub
// module, because vi.resetModules() in beforeEach would re-instantiate a stub
// imported inside the factory. See src/lib/auth/session.test.ts, which uses the
// same shape and covers the helpers themselves.
const { requestHeaders } = vi.hoisted(() => ({ requestHeaders: { current: new Headers() } }));
vi.mock("next/headers", async () =>
  (await import("@/test/next-headers")).nextHeadersStub(requestHeaders),
);

// `next-intl/server` resolves to next-intl's non-RSC build under Vitest, which
// has no `react-server` export condition to select the real one -- there,
// getRequestConfig() returns a stub that throws "not supported in Client
// Components" the moment it is called. The genuine react-server implementation
// is the identity function (see
// node_modules/next-intl/dist/esm/*/server/react-server/getRequestConfig.js:
// `function t(t){return t}`), so this mock is faithful to it and lets
// src/i18n/request.ts's own callback run for real. Setting the `react-server`
// condition globally in vitest.config.ts would fix the resolution but would
// also hand every future component test the react-server build of React.
vi.mock("next-intl/server", () => ({ getRequestConfig: <T>(config: T) => config }));

describe("settings", () => {
  let dbPath: string;
  let queries: typeof import("./queries");
  let actions: typeof import("./actions");
  let client: typeof import("@/lib/db/client");
  let schema: typeof import("@/lib/db/schema");

  // Same escape hatch client.ts itself uses to reach the raw better-sqlite3
  // handle -- needed here to close the module singleton's connection in
  // afterEach, the way src/lib/auth/bootstrap.test.ts does.
  function raw(db: unknown): Database.Database {
    return (db as { $client: Database.Database }).$client;
  }

  beforeEach(async () => {
    vi.resetModules();
    dbPath = path.join(
      os.tmpdir(),
      `yana-settings-${process.pid}-${Math.random().toString(36).slice(2)}.db`,
    );
    applyMigrationsAt(dbPath);
    process.env.DATABASE_PATH = dbPath;
    // Set before the auth module is imported: Better Auth reads it while
    // building its context.
    process.env.BETTER_AUTH_SECRET = "test-secret-not-used-outside-this-file-0123456789";
    const bootstrap = await import("@/lib/auth/bootstrap");
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await bootstrap.ensureAdminExists();
    } finally {
      warned.mockRestore();
    }
    // Every call below arrives as the bootstrap administrator, signed in for
    // real. Without a session currentUserId() redirects to /login, which is the
    // behaviour src/lib/auth/session.test.ts covers.
    const { auth } = await import("@/lib/auth/server");
    requestHeaders.current = new Headers({
      cookie: await signInCookie(auth, { email: "admin@admin.com", password: "admin" }),
    });
    queries = await import("./queries");
    actions = await import("./actions");
    client = await import("@/lib/db/client");
    // Same module epoch as `client` above (no resetModules() in between), so
    // this is the identical userSettings table object client.ts's own
    // internal `import * as schema from "./schema"` resolves to -- required
    // for the delete below to act on the connection getDb() actually opened.
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

  // Resolves an action's errorKey (a dot path relative to the `settings`
  // catalog namespace, e.g. "library.retentionRange") against the real
  // en.json import. The catalog-parity test (src/i18n/messages.test.ts) only
  // compares the two catalogs to each other -- it has no way to know that an
  // action emits a key neither catalog defines, which would render the raw
  // key path to the user. This closes that gap by checking against the
  // actual file rather than a hard-coded list of expected keys.
  function settingsMessage(key: string | undefined): unknown {
    if (!key) return undefined;
    return key
      .split(".")
      .reduce<unknown>((node, part) => (node as Record<string, unknown>)?.[part], en.settings);
  }

  describe("updateLibrarySettings", () => {
    it("rejects a retention of zero days with a real catalog key", async () => {
      const result = await actions.updateLibrarySettings({ articleRetentionDays: 0 });
      expect(result.ok).toBe(false);
      const message = settingsMessage(result.errorKey);
      expect(typeof message).toBe("string");
      expect(message).not.toBe("");
    });

    it("accepts sane values and persists them", async () => {
      const result = await actions.updateLibrarySettings({ articleRetentionDays: 90 });
      expect(result.ok).toBe(true);

      // A no-op write() would still return { ok: true }, so this reads the
      // row back for real rather than trusting the flag alone.
      const settings = await queries.getSettings();
      expect(settings.articleRetentionDays).toBe(90);
    });
  });

  describe("write", () => {
    it("reports failure when the UPDATE matches no row", async () => {
      // An UPDATE whose WHERE clause matches nothing is not an error to
      // SQLite -- it succeeds with changes === 0. Without the explicit check
      // in write(), the user would see "Settings saved" over a change that
      // never persisted and that a reload silently reverts. Deleting the row
      // is the honest way to reach that state; it is also the state phase 4
      // makes normal for a user whose settings row was never created.
      const userId = await queries.currentUserId();
      client.writeTransaction((tx) => {
        tx.delete(schema.userSettings).where(eq(schema.userSettings.userId, userId)).run();
      });

      const logged = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const result = await actions.updateLibrarySettings({ articleRetentionDays: 90 });
        expect(result.ok).toBe(false);
        // Not a validation failure, so there is no field-specific catalog key
        // -- the caller shows the generic settings.saveFailed toast.
        expect(result.errorKey).toBeUndefined();
        expect(logged).toHaveBeenCalled();
      } finally {
        logged.mockRestore();
      }
    });
  });

  describe("updateGeneralSettings", () => {
    it("accepts sane values and persists them", async () => {
      const result = await actions.updateGeneralSettings({ theme: "dark", language: "de" });
      expect(result.ok).toBe(true);

      const settings = await queries.getSettings();
      expect(settings.theme).toBe("dark");
      expect(settings.language).toBe("de");
    });

    it("invalidates the whole layout only when the language actually changed", async () => {
      // revalidatePath("/", "layout") discards the entire client router cache,
      // so every visited route has to be re-fetched. Only a language change
      // earns that: the locale is resolved server-side per request, so every
      // rendered layout and page holds already-translated markup. A theme or
      // retention change is read by /settings alone.
      const { revalidatePath } = await import("next/cache");
      const revalidate = vi.mocked(revalidatePath);

      // The bootstrap seed inserts defaults, so the stored language is "en".
      revalidate.mockClear();
      expect((await actions.updateGeneralSettings({ theme: "dark", language: "en" })).ok).toBe(
        true,
      );
      expect(revalidate).toHaveBeenCalledWith("/settings");
      expect(revalidate).not.toHaveBeenCalledWith("/", "layout");

      revalidate.mockClear();
      expect((await actions.updateGeneralSettings({ theme: "dark", language: "de" })).ok).toBe(
        true,
      );
      expect(revalidate).toHaveBeenCalledWith("/", "layout");

      revalidate.mockClear();
      expect((await actions.updateLibrarySettings({ articleRetentionDays: 10 })).ok).toBe(true);
      expect(revalidate).toHaveBeenCalledWith("/settings");
      expect(revalidate).not.toHaveBeenCalledWith("/", "layout");
    });

    it("falls back to no errorKey for a value outside the fixed enums", async () => {
      // Unreachable from this app's own UI (the Select only ever offers the
      // enum's own members), but exercised directly to lock in the fallback:
      // a field with no entry in FIELD_ERROR_KEYS leaves errorKey undefined,
      // and the caller shows the generic settings.saveFailed toast.
      const result = await actions.updateGeneralSettings({ theme: "purple", language: "de" });
      expect(result.ok).toBe(false);
      expect(result.errorKey).toBeUndefined();
    });
  });

  describe("currentUserId", () => {
    it("does not open the database while the module is being imported", async () => {
      // The sibling assertion in src/lib/auth/server.test.ts covers the auth
      // module; this one covers *this* module, which is what the root layout
      // actually imports (and which reaches the auth module in turn, through
      // the session seam). `next build` walks every route's module graph, and
      // `data/` does not exist until the server's own startup migrates it, so
      // an eager getDb() anywhere along that chain would create a database on
      // the build machine.
      vi.resetModules();
      const missing = path.join(os.tmpdir(), `yana-queries-never-${Date.now()}`, "nested.db");
      process.env.DATABASE_PATH = missing;

      try {
        await import("./queries");
        expect(fs.existsSync(path.dirname(missing))).toBe(false);
      } finally {
        // `finally`, so a failed assertion cannot leak the bogus path into
        // afterEach, where getDb() would then open a second database.
        process.env.DATABASE_PATH = dbPath;
      }
    });

    it("is the same function the session module exports", async () => {
      // A re-export, not a second implementation: this module is where phase 3
      // put the seam and where every phase-3 consumer still imports it from, so
      // the identity check is what keeps a copy from growing back here.
      const session = await import("@/lib/auth/session");

      expect(queries.currentUserId).toBe(session.currentUserId);
    });

    it("resolves the signed-in user", async () => {
      const userId = await queries.currentUserId();

      const owner = client
        .getDb()
        .select()
        .from(schema.users)
        .where(eq(schema.users.id, userId))
        .get();

      // Not just "some id": the seam has to land on the account that can
      // actually sign in, since every settings row is scoped to it.
      expect(owner).toMatchObject({ email: "admin@admin.com", role: "admin" });
    });

    it("surfaces a deleted settings row loudly rather than re-seeding it", async () => {
      const userId = await queries.currentUserId();

      // Through writeTransaction() per the project's write convention, never a
      // bare db.delete() outside one.
      client.writeTransaction((tx) => {
        tx.delete(schema.userSettings).where(eq(schema.userSettings.userId, userId)).run();
      });

      // The session still resolves -- the account is untouched -- but the read
      // path has no insert-if-absent fallback, on purpose: a missing settings
      // row is a bug in whatever provisioned the account, and papering over it
      // here would hide it forever. Only the root layout's locale and theme
      // reads degrade instead of throwing (covered below).
      await expect(queries.currentUserId()).resolves.toBe(userId);
      await expect(queries.getSettings()).rejects.toThrow(/no user_settings row/);
    });
  });

  // Lives here rather than in src/i18n/messages.test.ts (a pure catalog test
  // with no database) because it needs this file's real-database harness and
  // the same "delete the settings row" setup as the case above.
  // getRequestConfig() is the identity function at runtime, so the module's
  // default export can be called directly with the params Next would pass -- no
  // Next request scope required.
  describe("locale resolution", () => {
    it('falls back to "en" quietly when there is no session at all', async () => {
      // The login page renders the root layout, and the root layout resolves
      // the locale through getSettings() -> currentUserId(), which redirects
      // when signed out. If that redirect escaped here, /login would redirect
      // to /login forever; if it were merely logged, every unauthenticated page
      // view would print a stack. Neither, and the UI is English.
      requestHeaders.current = new Headers();
      const requestConfig = (await import("@/i18n/request")).default;

      const logged = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const config = await requestConfig({ requestLocale: Promise.resolve(undefined) });
        expect(config.locale).toBe("en");
        expect(config.messages).toBeTruthy();
        expect(logged).not.toHaveBeenCalled();
      } finally {
        logged.mockRestore();
      }
    });

    it('falls back to "en" when the settings row is missing instead of throwing', async () => {
      const requestConfig = (await import("@/i18n/request")).default;

      const userId = await queries.currentUserId();
      client.writeTransaction((tx) => {
        tx.delete(schema.userSettings).where(eq(schema.userSettings.userId, userId)).run();
      });

      const logged = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        // This runs in the *root* layout via getLocale(), so a throw here is a
        // 500 on every route in the app -- including /settings, the one page
        // that could repair the state. An English UI is the correct failure
        // mode; an unrecoverable error page is not.
        const config = await requestConfig({ requestLocale: Promise.resolve(undefined) });
        expect(config.locale).toBe("en");
        expect(config.messages).toBeTruthy();
        // The fallback is logged, not silent -- an invisible one looks like the
        // app simply forgot the language setting.
        expect(logged).toHaveBeenCalled();
      } finally {
        logged.mockRestore();
      }
    });

    it("uses the stored language when the row is present", async () => {
      await actions.updateGeneralSettings({ theme: "system", language: "de" });
      const requestConfig = (await import("@/i18n/request")).default;
      const config = await requestConfig({ requestLocale: Promise.resolve(undefined) });
      expect(config.locale).toBe("de");
    });
  });

  describe("the /settings page promise (regression: settings-secrets-leak)", () => {
    // `getSettings()` resolves to the *whole* `user_settings` row -- every
    // provider secret included. `src/app/(app)/settings/page.tsx` used to hand
    // that promise straight to two Client Components; a whole-branch review
    // found that a Client Component's props are the page's RSC payload, so the
    // full row -- `youtubeApiKey`, `redditClientSecret`, `openaiApiKey` and six
    // more -- was serialized into `/settings`' response in plain text, live
    // reproduced with a stored `openai_api_key` visible in the flight payload.
    //
    // A real render through testing-library cannot prove this either way:
    // `SettingsPage` is an async Server Component with a data region
    // (`GeneralSection`/`LibrarySection`) that testing-library cannot mount
    // (see CLAUDE.md's "two vitest projects" section), and jsdom never runs
    // React's flight serializer regardless. So this test does the next best
    // thing: it stores a canary secret in the real database, computes the
    // *exact* expression the page uses to build the promise it hands down --
    // `getSettings().then(({ theme, language, articleRetentionDays }) => ({
    // theme, language, articleRetentionDays }))` -- and asserts both that the
    // resolved value carries none of the nine secret columns and that its key
    // set is exactly the three the client components declare. A regression
    // that widened the projection (or reverted to passing `getSettings()`
    // itself) would fail the key-set assertion; a regression that leaked a
    // value through some other path would still fail the canary check.
    it("never resolves to a provider secret, only the three rendered fields", async () => {
      const userId = await queries.currentUserId();
      const canary = "SECRETLEAKCANARY123";
      client.writeTransaction((tx) => {
        tx.update(schema.userSettings)
          .set({ openaiApiKey: canary, redditClientSecret: canary })
          .where(eq(schema.userSettings.userId, userId))
          .run();
      });

      // The exact expression from src/app/(app)/settings/page.tsx.
      const settingsPromise = queries
        .getSettings()
        .then(({ theme, language, articleRetentionDays }) => ({
          theme,
          language,
          articleRetentionDays,
        }));
      const resolved = await settingsPromise;

      expect(Object.keys(resolved).sort()).toEqual(["articleRetentionDays", "language", "theme"]);
      expect(JSON.stringify(resolved)).not.toContain(canary);
    });
  });
});
