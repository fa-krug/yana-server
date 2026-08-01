import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { signInCookie } from "@/lib/auth/test-support";
import { applyMigrationsAt } from "@/lib/db/test-support";

/**
 * Real-database tests for `getIntegrationStatus()`.
 *
 * The property that matters here is negative and is the automatable half of a
 * hand check ("view source and confirm no raw secret appears"): **whatever this
 * function returns is what the page serialises into the RSC payload**, so a raw
 * credential anywhere in it is a plaintext secret in the browser's network tab.
 * The assertion therefore serialises the whole object and looks for the stored
 * values, rather than checking the fields it expects to be masked -- a field
 * added later without masking would slip past the second form and not the first.
 *
 * `next/headers` is stubbed for the session read, built from `nextHeadersStub()`
 * (which exports `cookies` as well -- see CLAUDE.md's `nextCookies()` rule).
 * Nothing else is: the row is real and so is the read.
 */
const { requestHeaders } = vi.hoisted(() => ({ requestHeaders: { current: new Headers() } }));
vi.mock("next/headers", async () =>
  (await import("@/test/next-headers")).nextHeadersStub(requestHeaders),
);

const YOUTUBE_KEY = "AIzaSyREALLOOKINGYOUTUBEKEY0001";
const REDDIT_ID = "redditClientId0001";
const REDDIT_SECRET = "redditClientSecret00000001";

describe("getIntegrationStatus", () => {
  let dbPath: string;
  let userId: string;
  let queries: typeof import("./queries");
  let client: typeof import("@/lib/db/client");
  let schema: typeof import("@/lib/db/schema");

  function raw(db: unknown): Database.Database {
    return (db as { $client: Database.Database }).$client;
  }

  function seed(values: Partial<typeof schema.userSettings.$inferInsert>): void {
    client.writeTransaction((tx) =>
      tx
        .update(schema.userSettings)
        .set(values)
        .where(eq(schema.userSettings.userId, userId))
        .run(),
    );
  }

  beforeEach(async () => {
    vi.resetModules();
    vi.spyOn(console, "warn").mockImplementation(() => {});

    dbPath = path.join(
      os.tmpdir(),
      `yana-integrations-queries-${process.pid}-${Math.random().toString(36).slice(2)}.db`,
    );
    applyMigrationsAt(dbPath);
    process.env.DATABASE_PATH = dbPath;
    process.env.BETTER_AUTH_SECRET = "test-secret-not-used-outside-this-file-0123456789";

    const bootstrap = await import("@/lib/auth/bootstrap");
    await bootstrap.ensureAdminExists();

    const { auth } = await import("@/lib/auth/server");
    requestHeaders.current = new Headers({
      cookie: await signInCookie(auth, { email: "admin@admin.com", password: "admin" }),
    });

    queries = await import("./queries");
    client = await import("@/lib/db/client");
    schema = await import("@/lib/db/schema");

    const connection = new Database(dbPath);
    try {
      userId = (
        connection.prepare("SELECT id FROM users WHERE email = ?").get("admin@admin.com") as {
          id: string;
        }
      ).id;
    } finally {
      connection.close();
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.DATABASE_PATH;
    delete process.env.BETTER_AUTH_SECRET;
    const connection = raw(client.getDb());
    if (connection.open) connection.close();
    for (const suffix of ["", "-shm", "-wal"]) {
      fs.rmSync(`${dbPath}${suffix}`, { force: true });
    }
  });

  it("never returns a raw secret, anywhere in the object", async () => {
    seed({
      youtubeApiKey: YOUTUBE_KEY,
      youtubeEnabled: true,
      redditClientId: REDDIT_ID,
      redditClientSecret: REDDIT_SECRET,
      redditEnabled: true,
    });

    const status = await queries.getIntegrationStatus();

    const serialised = JSON.stringify(status);
    for (const secret of [YOUTUBE_KEY, REDDIT_ID, REDDIT_SECRET]) {
      expect(serialised).not.toContain(secret);
    }
    // Nor a recoverable prefix of one: only the last four characters are shown.
    expect(serialised).not.toContain(YOUTUBE_KEY.slice(0, 8));
  });

  it("masks each credential and keeps the last four characters as the hint", async () => {
    seed({
      youtubeApiKey: YOUTUBE_KEY,
      redditClientId: REDDIT_ID,
      redditClientSecret: REDDIT_SECRET,
    });

    const status = await queries.getIntegrationStatus();

    expect(status.youtube.apiKeyMasked).toBe(`••••••••${YOUTUBE_KEY.slice(-4)}`);
    expect(status.reddit.clientIdMasked).toBe(`••••••••${REDDIT_ID.slice(-4)}`);
    expect(status.reddit.clientSecretMasked).toBe(`••••••••${REDDIT_SECRET.slice(-4)}`);
  });

  it("reports an unset credential as an empty mask, not as bullets", async () => {
    // The form uses this to tell "nothing stored" from "something stored":
    // bullets over an empty column would offer a Remove button for nothing and
    // promise a value that is not there.
    const status = await queries.getIntegrationStatus();

    expect(status.youtube.apiKeyMasked).toBe("");
    expect(status.reddit.clientIdMasked).toBe("");
    expect(status.reddit.clientSecretMasked).toBe("");
  });

  it("reports the enabled flags as stored, and the user agent in full", async () => {
    // The User-Agent is deliberately not masked: it is not a credential, it is
    // sent to Reddit on every request, and it is the field an operator most
    // often has to correct.
    seed({ youtubeEnabled: true, redditEnabled: false, redditUserAgent: "Yana/1.0 (by u/tester)" });

    const status = await queries.getIntegrationStatus();

    expect(status.youtube.enabled).toBe(true);
    expect(status.reddit.enabled).toBe(false);
    expect(status.reddit.userAgent).toBe("Yana/1.0 (by u/tester)");
  });

  it("reads the caller's own row, not the first one in the table", async () => {
    // Credentials are per user. Without a second account, a query missing its
    // WHERE clause would pass every assertion above.
    const { createUserWithPassword } = await import("@/lib/auth/server");
    const other = await createUserWithPassword({
      email: "other@example.com",
      password: "correct horse battery staple",
    });
    client.writeTransaction((tx) =>
      tx
        .insert(schema.userSettings)
        .values({ userId: other.id, youtubeApiKey: "someone-elses-key", youtubeEnabled: true })
        .run(),
    );
    seed({ youtubeApiKey: YOUTUBE_KEY });

    const status = await queries.getIntegrationStatus();

    // The two masks differ in their last four characters, so this is decisive.
    expect(status.youtube.apiKeyMasked).toBe(`••••••••${YOUTUBE_KEY.slice(-4)}`);
    expect(status.youtube.apiKeyMasked).not.toBe("••••••••-key");
  });
});
