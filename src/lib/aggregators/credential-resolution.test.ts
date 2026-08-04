import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
    let feed: InstanceType<typeof Object> & Record<string, unknown>;

    client.writeTransaction((db) => {
      db.insert(schema.users).values({ id: "user1", email: "user1@example.com" }).run();
      db.insert(schema.userSettings)
        .values({
          userId: "user1",
          redditEnabled: true,
          redditClientId: "abc123",
          redditClientSecret: "shh",
          redditUserAgent: "Yana/1.0 (test)",
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

    const resolved = resolution.resolveFeedCredentials(feed! as never);

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
    let feed: InstanceType<typeof Object> & Record<string, unknown>;

    client.writeTransaction((db) => {
      db.insert(schema.users).values({ id: "user2", email: "user2@example.com" }).run();
      db.insert(schema.userSettings)
        .values({
          userId: "user2",
          redditClientId: "fresh-value-from-user-settings",
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

    const resolved = resolution.resolveFeedCredentials(feed! as never);

    expect((resolved.options as Record<string, unknown>).reddit_client_id).toBe(
      "fresh-value-from-user-settings",
    );
  });

  it("returns the feed unchanged when the owner has no user_settings row", () => {
    let feed: InstanceType<typeof Object> & Record<string, unknown>;

    client.writeTransaction((db) => {
      db.insert(schema.users).values({ id: "orphan", email: "orphan@example.com" }).run();
      feed = db
        .insert(schema.feeds)
        .values({ name: "r/test", userId: "orphan", aggregator: "reddit" })
        .returning()
        .get();
    });

    const resolved = resolution.resolveFeedCredentials(feed! as never);
    expect(resolved).toBe(feed!);
  });
});
