import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyMigrationsAt } from "../db/test-support";

describe("resolveChromeLabels", () => {
  let dbPath: string;
  let client: typeof import("../db/client");
  let schema: typeof import("../db/schema");
  let chromeLabels: typeof import("./chrome-labels");

  beforeEach(async () => {
    vi.resetModules();
    dbPath = path.join(
      os.tmpdir(),
      `yana-chromelabels-${process.pid}-${Math.random().toString(36).slice(2)}.db`,
    );
    process.env.DATABASE_PATH = dbPath;
    applyMigrationsAt(dbPath);

    client = await import("../db/client");
    schema = await import("../db/schema");
    chromeLabels = await import("./chrome-labels");
  });

  afterEach(() => {
    delete process.env.DATABASE_PATH;
    const connection = (client.getDb() as unknown as { $client: Database.Database }).$client;
    if (connection.open) connection.close();
    for (const suffix of ["", "-shm", "-wal"]) {
      fs.rmSync(`${dbPath}${suffix}`, { force: true });
    }
  });

  it("returns English defaults without touching the database when userId is missing", async () => {
    const labels = await chromeLabels.resolveChromeLabels(undefined);
    expect(labels).toEqual(chromeLabels.DEFAULT_CHROME_LABELS);
    expect(labels.comments).toBe("Comments");
    expect(labels.source).toBe("source");
  });

  it("returns English defaults for null userId", async () => {
    const labels = await chromeLabels.resolveChromeLabels(null);
    expect(labels).toEqual(chromeLabels.DEFAULT_CHROME_LABELS);
  });

  it("resolves English labels for a user whose language is en", async () => {
    client.writeTransaction((db) => {
      db.insert(schema.users).values({ id: "user1", email: "user1@example.com" }).run();
      db.insert(schema.userSettings).values({ userId: "user1", language: "en" }).run();
    });

    const labels = await chromeLabels.resolveChromeLabels("user1");
    expect(labels.comments).toBe("Comments");
    expect(labels.source).toBe("source");
    expect(labels.noCommentsYet).toBe("No comments yet.");
  });

  it("resolves German labels for a user whose language is de", async () => {
    client.writeTransaction((db) => {
      db.insert(schema.users).values({ id: "user1", email: "user1@example.com" }).run();
      db.insert(schema.userSettings).values({ userId: "user1", language: "de" }).run();
    });

    const labels = await chromeLabels.resolveChromeLabels("user1");
    expect(labels.comments).toBe("Kommentare");
    expect(labels.source).toBe("Quelle");
    expect(labels.noCommentsYet).toBe("Noch keine Kommentare.");
    expect(labels.commentsDisabled).toBe("Kommentare deaktiviert.");
    expect(labels.commentsUnavailable).toBe("Kommentare nicht verfügbar.");
    expect(labels.viewVideoOnYoutube).toBe("▶ Video auf YouTube ansehen");
    expect(labels.viewVideo).toBe("▶ Video ansehen");
  });

  it("falls back to English when there is no user_settings row for the given id", async () => {
    const labels = await chromeLabels.resolveChromeLabels("no-such-user");
    expect(labels).toEqual(chromeLabels.DEFAULT_CHROME_LABELS);
  });

  it("accepts a numeric userId by coercing it to the text user_settings.userId column", async () => {
    // Feed.userId's type is `string | number | null` on FeedLike, even though every
    // real feed row's userId is text -- this proves the numeric branch doesn't throw
    // and simply finds no matching row (falls back to English).
    const labels = await chromeLabels.resolveChromeLabels(42);
    expect(labels).toEqual(chromeLabels.DEFAULT_CHROME_LABELS);
  });
});
