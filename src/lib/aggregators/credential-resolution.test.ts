import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Feed } from "../db/schema";
import { applyMigrationsAt } from "../db/test-support";

describe("resolveFeedCredentials", () => {
  let dbPath: string;
  let client: typeof import("../db/client");
  let schema: typeof import("../db/schema");
  let resolution: typeof import("./credential-resolution");

  beforeEach(async () => {
    vi.resetModules();
    dbPath = path.join(
      os.tmpdir(),
      `yana-credres-${process.pid}-${Math.random().toString(36).slice(2)}.db`,
    );
    process.env.DATABASE_PATH = dbPath;
    applyMigrationsAt(dbPath);

    client = await import("../db/client");
    schema = await import("../db/schema");
    resolution = await import("./credential-resolution");
  });

  afterEach(() => {
    delete process.env.DATABASE_PATH;
    const connection = (client.getDb() as unknown as { $client: Database.Database }).$client;
    if (connection.open) connection.close();
    for (const suffix of ["", "-shm", "-wal"]) {
      fs.rmSync(`${dbPath}${suffix}`, { force: true });
    }
  });

  it("merges the feed owner's stored Reddit/YouTube credentials into feed.options", () => {
    let feed: Feed;

    client.writeTransaction((db) => {
      db.insert(schema.users).values({ id: "user1", email: "user1@example.com" }).run();
      db.insert(schema.userSettings)
        .values({
          userId: "user1",
          redditEnabled: true,
          redditClientId: "abc123",
          redditClientSecret: "shh",
          redditUserAgent: "Yana/1.0 (test)",
          youtubeEnabled: true,
          youtubeApiKey: "yt-key",
        })
        .run();
      feed = db
        .insert(schema.feeds)
        .values({
          name: "r/test",
          userId: "user1",
          aggregator: "reddit",
          options: { min_comments: 3 },
        })
        .returning()
        .get();
    });

    const resolved = resolution.resolveFeedCredentials(feed!);

    expect(resolved.options).toEqual({
      min_comments: 3,
      reddit_enabled: true,
      reddit_client_id: "abc123",
      reddit_client_secret: "shh",
      reddit_user_agent: "Yana/1.0 (test)",
      youtube_api_key: "yt-key",
    });
  });

  it("prefers the owner's stored credential over a colliding key already in feed.options", () => {
    let feed: Feed;

    client.writeTransaction((db) => {
      db.insert(schema.users).values({ id: "user2", email: "user2@example.com" }).run();
      db.insert(schema.userSettings)
        .values({
          userId: "user2",
          redditEnabled: true,
          redditClientId: "fresh-value-from-user-settings",
          redditClientSecret: "shh",
        })
        .run();
      feed = db
        .insert(schema.feeds)
        .values({
          name: "r/test",
          userId: "user2",
          aggregator: "reddit",
          options: { reddit_client_id: "stale-value-from-feed-options" },
        })
        .returning()
        .get();
    });

    const resolved = resolution.resolveFeedCredentials(feed!);

    expect((resolved.options as Record<string, unknown>).reddit_client_id).toBe(
      "fresh-value-from-user-settings",
    );
  });

  it("returns the feed unchanged when the owner has no user_settings row", () => {
    let feed: Feed;

    client.writeTransaction((db) => {
      db.insert(schema.users).values({ id: "orphan", email: "orphan@example.com" }).run();
      feed = db
        .insert(schema.feeds)
        .values({ name: "r/test", userId: "orphan", aggregator: "reddit" })
        .returning()
        .get();
    });

    const resolved = resolution.resolveFeedCredentials(feed!);
    expect(resolved).toBe(feed!);
  });

  it("injects nothing for an unconfigured owner, so the env-var fallback is not shadowed", () => {
    let feed: Feed;

    // A user who never visited /integrations still has a user_settings row: the
    // defaults are reddit_enabled = 0, empty credentials and the NOT NULL
    // reddit_user_agent default "Yana/1.0".
    client.writeTransaction((db) => {
      db.insert(schema.users).values({ id: "fresh", email: "fresh@example.com" }).run();
      db.insert(schema.userSettings).values({ userId: "fresh" }).run();
      feed = db
        .insert(schema.feeds)
        .values({
          name: "r/test",
          userId: "fresh",
          aggregator: "reddit",
          options: { min_comments: 3 },
        })
        .returning()
        .get();
    });

    const resolved = resolution.resolveFeedCredentials(feed!);
    const options = resolved.options as Record<string, unknown>;

    expect(options).toEqual({ min_comments: 3 });
    expect(options).not.toHaveProperty("reddit_enabled");
    expect(options).not.toHaveProperty("reddit_client_id");
    expect(options).not.toHaveProperty("reddit_client_secret");
    expect(options).not.toHaveProperty("reddit_user_agent");
    expect(options).not.toHaveProperty("youtube_api_key");
  });

  it("injects nothing for Reddit when the probe rejected the stored credentials", () => {
    let feed: Feed;

    // judge()'s `bad` arm stores a refused credential with reddit_enabled = 0.
    client.writeTransaction((db) => {
      db.insert(schema.users).values({ id: "rejected", email: "rejected@example.com" }).run();
      db.insert(schema.userSettings)
        .values({
          userId: "rejected",
          redditEnabled: false,
          redditClientId: "known-bad-id",
          redditClientSecret: "known-bad-secret",
          redditUserAgent: "Yana/1.0",
        })
        .run();
      feed = db
        .insert(schema.feeds)
        .values({ name: "r/test", userId: "rejected", aggregator: "reddit" })
        .returning()
        .get();
    });

    const options = resolution.resolveFeedCredentials(feed!).options as Record<string, unknown>;

    expect(options).not.toHaveProperty("reddit_client_id");
    expect(options).not.toHaveProperty("reddit_client_secret");
    expect(options).not.toHaveProperty("reddit_user_agent");
    expect(options).not.toHaveProperty("reddit_enabled");
  });

  it("injects nothing for Reddit when enabled but a credential half is empty", () => {
    let feed: Feed;

    client.writeTransaction((db) => {
      db.insert(schema.users).values({ id: "half", email: "half@example.com" }).run();
      db.insert(schema.userSettings)
        .values({
          userId: "half",
          redditEnabled: true,
          redditClientId: "an-id",
          redditClientSecret: "",
        })
        .run();
      feed = db
        .insert(schema.feeds)
        .values({ name: "r/test", userId: "half", aggregator: "reddit" })
        .returning()
        .get();
    });

    const options = resolution.resolveFeedCredentials(feed!).options as Record<string, unknown>;

    expect(options).not.toHaveProperty("reddit_client_id");
    expect(options).not.toHaveProperty("reddit_user_agent");
  });

  it("preserves an existing feed.options value rather than overwriting it when unconfigured", () => {
    let feed: Feed;

    client.writeTransaction((db) => {
      db.insert(schema.users).values({ id: "keeper", email: "keeper@example.com" }).run();
      db.insert(schema.userSettings).values({ userId: "keeper" }).run();
      feed = db
        .insert(schema.feeds)
        .values({
          name: "r/test",
          userId: "keeper",
          aggregator: "reddit",
          options: { reddit_user_agent: "Yana/1.0 (operator override)" },
        })
        .returning()
        .get();
    });

    const options = resolution.resolveFeedCredentials(feed!).options as Record<string, unknown>;

    expect(options.reddit_user_agent).toBe("Yana/1.0 (operator override)");
  });

  it("omits youtube_api_key when the stored key is empty", () => {
    let feed: Feed;

    client.writeTransaction((db) => {
      db.insert(schema.users).values({ id: "noyt", email: "noyt@example.com" }).run();
      db.insert(schema.userSettings).values({ userId: "noyt", youtubeApiKey: "" }).run();
      feed = db
        .insert(schema.feeds)
        .values({ name: "chan", userId: "noyt", aggregator: "youtube" })
        .returning()
        .get();
    });

    const options = resolution.resolveFeedCredentials(feed!).options as Record<string, unknown>;

    expect(options).not.toHaveProperty("youtube_api_key");
  });

  it("injects nothing for YouTube when the probe rejected the stored credentials", () => {
    let feed: Feed;

    // judge()'s `bad` arm stores a refused credential with youtube_enabled = 0,
    // same as the Reddit case above.
    client.writeTransaction((db) => {
      db.insert(schema.users).values({ id: "yt-rejected", email: "yt-rejected@example.com" }).run();
      db.insert(schema.userSettings)
        .values({
          userId: "yt-rejected",
          youtubeEnabled: false,
          youtubeApiKey: "known-bad-key",
        })
        .run();
      feed = db
        .insert(schema.feeds)
        .values({ name: "chan", userId: "yt-rejected", aggregator: "youtube" })
        .returning()
        .get();
    });

    const options = resolution.resolveFeedCredentials(feed!).options as Record<string, unknown>;

    expect(options).not.toHaveProperty("youtube_api_key");
  });

  it("uses a passed-in settings row instead of querying for one, so a caller that already read it doesn't pay twice", () => {
    let feed: Feed;
    let dbSettings: typeof schema.userSettings.$inferSelect | undefined;

    client.writeTransaction((db) => {
      db.insert(schema.users).values({ id: "known-settings", email: "ks@example.com" }).run();
      dbSettings = db
        .insert(schema.userSettings)
        .values({ userId: "known-settings", youtubeEnabled: true, youtubeApiKey: "db-key" })
        .returning()
        .get();
      feed = db
        .insert(schema.feeds)
        .values({ name: "chan", userId: "known-settings", aggregator: "youtube" })
        .returning()
        .get();
    });

    // A copy of the real row with a different key -- if resolveFeedCredentials
    // used this instead of querying, the DB's "db-key" never enters the result.
    const handedInSettings = { ...dbSettings!, youtubeApiKey: "hand-key" };

    const resolved = resolution.resolveFeedCredentials(feed!, handedInSettings);

    expect((resolved.options as Record<string, unknown>).youtube_api_key).toBe("hand-key");
  });

  it("treats an explicit null settings row as 'already checked, none exists' rather than querying", () => {
    let feed: Feed;

    client.writeTransaction((db) => {
      db.insert(schema.users).values({ id: "explicit-null", email: "en@example.com" }).run();
      db.insert(schema.userSettings)
        .values({ userId: "explicit-null", youtubeEnabled: true, youtubeApiKey: "would-be-found" })
        .run();
      feed = db
        .insert(schema.feeds)
        .values({ name: "chan", userId: "explicit-null", aggregator: "youtube" })
        .returning()
        .get();
    });

    // A caller passing `null` is asserting it already looked and found
    // nothing -- resolveFeedCredentials must trust that rather than querying
    // user_settings itself, which does have a row for this user.
    const resolved = resolution.resolveFeedCredentials(feed!, null);

    expect(resolved).toBe(feed!);
    expect(resolved.options).toEqual({});
  });
});
