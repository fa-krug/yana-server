import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyMigrationsAt } from "@/lib/db/test-support";
import en from "../../../messages/en.json";

// Real-database test, no driver mocks -- see CLAUDE.md's testing convention
// and src/lib/db/bootstrap.test.ts, which this follows. Each test points
// DATABASE_PATH at its own temp file, migrates it the way docker-entrypoint.sh
// does (applyMigrationsAt -> migrate()), then exercises the actions/queries
// through the real getDb()/writeTransaction() singleton.
//
// next/cache's revalidatePath() is the one thing stubbed: it requires a Next
// request scope that does not exist under Vitest and throws if called for
// real, and it has no database behavior of its own to verify. Everything
// touching SQLite runs unmocked.
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

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
  // afterEach, the way bootstrap.test.ts does.
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
      const result = await actions.updateLibrarySettings({
        articleRetentionDays: 0,
        updateIntervalMinutes: 30,
      });
      expect(result.ok).toBe(false);
      const message = settingsMessage(result.errorKey);
      expect(typeof message).toBe("string");
      expect(message).not.toBe("");
    });

    it("rejects an update interval below one minute with a real catalog key", async () => {
      const result = await actions.updateLibrarySettings({
        articleRetentionDays: 60,
        updateIntervalMinutes: 0,
      });
      expect(result.ok).toBe(false);
      const message = settingsMessage(result.errorKey);
      expect(typeof message).toBe("string");
      expect(message).not.toBe("");
    });

    it("accepts sane values and persists them", async () => {
      const result = await actions.updateLibrarySettings({
        articleRetentionDays: 90,
        updateIntervalMinutes: 15,
      });
      expect(result.ok).toBe(true);

      // A no-op write() would still return { ok: true }, so this reads the
      // row back for real rather than trusting the flag alone.
      const settings = await queries.getSettings();
      expect(settings.articleRetentionDays).toBe(90);
      expect(settings.updateIntervalMinutes).toBe(15);
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
        const result = await actions.updateLibrarySettings({
          articleRetentionDays: 90,
          updateIntervalMinutes: 15,
        });
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
      expect(
        (
          await actions.updateLibrarySettings({
            articleRetentionDays: 10,
            updateIntervalMinutes: 10,
          })
        ).ok,
      ).toBe(true);
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
    it("memoizes the bootstrap seed per process: a deleted settings row stays deleted", async () => {
      const userId = await queries.currentUserId();

      // Delete the row the first call's seed created, through
      // writeTransaction() per the project's write convention -- never a bare
      // db.delete() outside one.
      client.writeTransaction((tx) => {
        tx.delete(schema.userSettings).where(eq(schema.userSettings.userId, userId)).run();
      });

      await queries.currentUserId();

      // If the bootstrap seed had re-run, ensureBootstrapUser()'s
      // existing-row check would have found none and recreated it. It
      // doesn't: the seed already ran once for this process and is memoized,
      // so the second call is a no-op. This also documents the real tradeoff
      // of that memoization -- the seed is not self-healing within a
      // process's lifetime.
      await expect(queries.getSettings()).rejects.toThrow(/no user_settings row/);
    });
  });

  // Lives here rather than in src/i18n/messages.test.ts (a pure catalog test
  // with no database) because it needs this file's real-database harness and
  // the same "delete the row the memoized seed created" setup as the case
  // above. getRequestConfig() is the identity function at runtime, so the
  // module's default export can be called directly with the params Next would
  // pass -- no Next request scope required.
  describe("locale resolution", () => {
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
});
