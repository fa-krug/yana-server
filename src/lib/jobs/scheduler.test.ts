import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyMigrationsAt } from "../db/test-support";

const notifyAdminsMock = vi.fn();
vi.mock("../email/error-notifications", () => ({
  notifyAdmins: notifyAdminsMock,
  notifyJobFailure: vi.fn(),
}));

describe("src/lib/jobs/scheduler", () => {
  let dbPath: string;
  let queue: typeof import("./queue");
  let scheduler: typeof import("./scheduler");
  let client: typeof import("../db/client");
  let schema: typeof import("../db/schema");

  beforeEach(async () => {
    vi.resetModules();
    dbPath = path.join(
      os.tmpdir(),
      `yana-sched-${process.pid}-${Math.random().toString(36).slice(2)}.db`,
    );
    process.env.DATABASE_PATH = dbPath;
    applyMigrationsAt(dbPath);

    client = await import("../db/client");
    schema = await import("../db/schema");
    queue = await import("./queue");
    scheduler = await import("./scheduler");
    notifyAdminsMock.mockClear();
  });

  afterEach(() => {
    scheduler.stopScheduler();
    delete process.env.DATABASE_PATH;
    const connection = (client.getDb() as unknown as { $client: Database.Database }).$client;
    if (connection.open) connection.close();
    for (const suffix of ["", "-shm", "-wal"]) {
      fs.rmSync(`${dbPath}${suffix}`, { force: true });
    }
  });

  it("enqueues aggregate job for enabled due feeds and deduplicates", async () => {
    let feedId = 0;
    client.writeTransaction((db) => {
      let user = db.select().from(schema.users).limit(1).get();
      if (!user) {
        db.insert(schema.users).values({ id: "user1", email: "user1@example.com" }).run();
        user = db.select().from(schema.users).limit(1).get();
      }

      const inserted = db
        .insert(schema.feeds)
        .values({
          name: "Test Feed",
          aggregator: "full_website",
          userId: user!.id,
          enabled: true,
        })
        .returning({ id: schema.feeds.id })
        .get();
      feedId = inserted.id;

      // Simulate a feed last aggregated an hour ago, via the scheduler's own
      // clock -- not updatedAt, which $onUpdate would bump on this very insert.
      const oneHourAgoSec = Math.floor((Date.now() - 3_600_000) / 1000);
      db.run(
        sql`UPDATE feeds SET last_aggregation_started_at = ${oneHourAgoSec} WHERE id = ${feedId}`,
      );
    });

    await scheduler.tick();

    const { jobs: jobList } = queue.listJobs({ kind: "aggregate" });
    expect(jobList.length).toBe(1);
    expect(jobList[0].payload).toEqual({ feedId });

    // Running tick again should deduplicate and not enqueue another aggregate job
    await scheduler.tick();

    const { jobs: jobList2 } = queue.listJobs({ kind: "aggregate" });
    expect(jobList2.length).toBe(1);
  });

  it("does not enqueue a duplicate when an aggregate job for the feed is already running", async () => {
    let feedId = 0;
    client.writeTransaction((db) => {
      let user = db.select().from(schema.users).limit(1).get();
      if (!user) {
        db.insert(schema.users).values({ id: "user1", email: "user1@example.com" }).run();
        user = db.select().from(schema.users).limit(1).get();
      }

      const inserted = db
        .insert(schema.feeds)
        .values({
          name: "Test Feed",
          aggregator: "full_website",
          userId: user!.id,
          enabled: true,
        })
        .returning({ id: schema.feeds.id })
        .get();
      feedId = inserted.id;

      const oneHourAgoSec = Math.floor((Date.now() - 3_600_000) / 1000);
      db.run(
        sql`UPDATE feeds SET last_aggregation_started_at = ${oneHourAgoSec} WHERE id = ${feedId}`,
      );
    });

    // A job for this feed is already in flight -- claim() moves it from
    // pending to running, exactly as a worker loop would.
    queue.enqueue("aggregate", { feedId });
    const claimed = queue.claim();
    expect(claimed?.status).toBe("running");

    await scheduler.tick();

    const { jobs: jobList } = queue.listJobs({ kind: "aggregate" });
    expect(jobList.length).toBe(1);
  });

  it("does not enqueue a duplicate aggregate job when a pending feed.update job covers the feed", async () => {
    let feedId = 0;
    client.writeTransaction((db) => {
      let user = db.select().from(schema.users).limit(1).get();
      if (!user) {
        db.insert(schema.users).values({ id: "user1", email: "user1@example.com" }).run();
        user = db.select().from(schema.users).limit(1).get();
      }

      const inserted = db
        .insert(schema.feeds)
        .values({
          name: "Test Feed",
          aggregator: "full_website",
          userId: user!.id,
          enabled: true,
        })
        .returning({ id: schema.feeds.id })
        .get();
      feedId = inserted.id;

      const oneHourAgoSec = Math.floor((Date.now() - 3_600_000) / 1000);
      db.run(
        sql`UPDATE feeds SET last_aggregation_started_at = ${oneHourAgoSec} WHERE id = ${feedId}`,
      );
    });

    // updateFeedsBulk() enqueues this kind, and it runs the same handler as
    // "aggregate" -- see src/lib/jobs/handlers/index.ts.
    queue.enqueue("feed.update", { feedId });

    await scheduler.tick();

    const { jobs: aggregateJobs } = queue.listJobs({ kind: "aggregate" });
    expect(aggregateJobs.length).toBe(0);
    const { jobs: updateJobs } = queue.listJobs({ kind: "feed.update" });
    expect(updateJobs.length).toBe(1);
  });

  it("does not postpone a feed's next scheduled aggregation when the feed is merely edited", async () => {
    // Reproduces the bug this task fixes: feeds.updatedAt carries $onUpdate,
    // so any Drizzle write to the feed row -- a name edit, a logo store --
    // used to read as "just aggregated" to the scheduler, silently pushing
    // the feed's next run a full interval into the future. The fix gives the
    // scheduler a dedicated clock (lastAggregationStartedAt) that only
    // claim() stamps, so an unrelated edit like this one must not move it.
    let feedId = 0;
    client.writeTransaction((db) => {
      let user = db.select().from(schema.users).limit(1).get();
      if (!user) {
        db.insert(schema.users).values({ id: "user1", email: "user1@example.com" }).run();
        user = db.select().from(schema.users).limit(1).get();
      }

      const inserted = db
        .insert(schema.feeds)
        .values({
          name: "Test Feed",
          aggregator: "full_website",
          userId: user!.id,
          enabled: true,
        })
        .returning({ id: schema.feeds.id })
        .get();
      feedId = inserted.id;

      // Simulate a feed genuinely aggregated an hour ago -- overdue for its
      // (default 30-minute) interval -- via the scheduler's own clock.
      const oneHourAgoSec = Math.floor((Date.now() - 3_600_000) / 1000);
      db.run(
        sql`UPDATE feeds SET last_aggregation_started_at = ${oneHourAgoSec} WHERE id = ${feedId}`,
      );
    });

    // An unrelated edit -- exactly what /feeds' edit form or storeLogo()
    // does -- which bumps updatedAt via $onUpdate, but must not touch
    // lastAggregationStartedAt.
    client.writeTransaction((db) => {
      db.update(schema.feeds)
        .set({ name: "Renamed Feed" })
        .where(sql`id = ${feedId}`)
        .run();
    });

    await scheduler.tick();

    // The feed was overdue before the edit and the edit did not aggregate
    // it, so it must still be enqueued -- not silently postponed by the
    // edit's incidental updatedAt bump.
    const { jobs: jobList } = queue.listJobs({ kind: "aggregate" });
    expect(jobList.length).toBe(1);
    expect(jobList[0].payload).toEqual({ feedId });
  });

  it("picks up a feed that predates the lastAggregationStartedAt column on the first tick", async () => {
    // A NULL lastAggregationStartedAt (every row from before this migration,
    // and every never-yet-aggregated feed) must read as "never aggregated",
    // not be skipped and not stampede -- it is simply due immediately.
    let feedId = 0;
    client.writeTransaction((db) => {
      let user = db.select().from(schema.users).limit(1).get();
      if (!user) {
        db.insert(schema.users).values({ id: "user1", email: "user1@example.com" }).run();
        user = db.select().from(schema.users).limit(1).get();
      }

      const inserted = db
        .insert(schema.feeds)
        .values({
          name: "Never Aggregated Feed",
          aggregator: "full_website",
          userId: user!.id,
          enabled: true,
        })
        .returning({ id: schema.feeds.id })
        .get();
      feedId = inserted.id;

      // lastAggregationStartedAt is left NULL -- both a brand-new feed and a
      // pre-migration row look like this.
      expect(
        db
          .select({ lastAggregationStartedAt: schema.feeds.lastAggregationStartedAt })
          .from(schema.feeds)
          .where(sql`id = ${feedId}`)
          .get()?.lastAggregationStartedAt,
      ).toBeNull();
    });

    await scheduler.tick();

    const { jobs: jobList } = queue.listJobs({ kind: "aggregate" });
    expect(jobList.length).toBe(1);
    expect(jobList[0].payload).toEqual({ feedId });
  });

  it("adds the column onto a genuinely pre-migration database, and the existing row still schedules", async () => {
    // Not the "fresh database" case above (a feed inserted after every
    // migration, including this one, has run) -- this reproduces an actual
    // upgrade: migrate a database up to the migration *before* this task's,
    // insert a feed the way that older schema allowed (no
    // last_aggregation_started_at column exists at all yet), then apply the
    // real, full migrations folder on top -- exactly what the server's
    // startup hook does on every boot -- and confirm the pre-existing row
    // reads as NULL (never aggregated) rather than erroring or defaulting to
    // "now", and is picked up on the very next tick.
    const { applyMigrations: rawApplyMigrations } = await import("../db/migrate");
    const { MIGRATIONS_FOLDER: realFolder } = await import("../db/test-support");
    const { drizzle } = await import("drizzle-orm/better-sqlite3");

    const journal = JSON.parse(
      fs.readFileSync(path.join(realFolder, "meta", "_journal.json"), "utf8"),
    ) as { entries: { tag: string }[] };
    const priorEntries = journal.entries.slice(0, -1);
    expect(priorEntries.length).toBe(journal.entries.length - 1);

    const priorFolder = fs.mkdtempSync(path.join(os.tmpdir(), "yana-migrations-prior-"));
    fs.mkdirSync(path.join(priorFolder, "meta"));
    fs.writeFileSync(
      path.join(priorFolder, "meta", "_journal.json"),
      JSON.stringify({ ...journal, entries: priorEntries }),
    );
    for (const entry of priorEntries) {
      fs.copyFileSync(
        path.join(realFolder, `${entry.tag}.sql`),
        path.join(priorFolder, `${entry.tag}.sql`),
      );
    }

    const existingDbPath = path.join(
      os.tmpdir(),
      `yana-sched-existing-${process.pid}-${Math.random().toString(36).slice(2)}.db`,
    );
    let existingFeedId = 0;

    try {
      // Pre-upgrade state: feeds has no last_aggregation_started_at column.
      const priorConnection = new Database(existingDbPath);
      rawApplyMigrations(drizzle(priorConnection), priorFolder);
      priorConnection
        .prepare("INSERT INTO users (id, email) VALUES (?, ?)")
        .run("existing-user", "existing@example.com");
      const feedResult = priorConnection
        .prepare("INSERT INTO feeds (name, user_id) VALUES (?, ?)")
        .run("Pre-migration Feed", "existing-user");
      existingFeedId = Number(feedResult.lastInsertRowid);
      priorConnection.close();

      // The real upgrade: apply every migration, including this task's.
      applyMigrationsAt(existingDbPath);

      vi.resetModules();
      process.env.DATABASE_PATH = existingDbPath;
      const existingClient: typeof import("../db/client") = await import("../db/client");
      const existingSchema: typeof import("../db/schema") = await import("../db/schema");
      const existingQueue: typeof import("./queue") = await import("./queue");
      const existingScheduler: typeof import("./scheduler") = await import("./scheduler");

      const rerow = existingClient
        .getDb()
        .select({ lastAggregationStartedAt: existingSchema.feeds.lastAggregationStartedAt })
        .from(existingSchema.feeds)
        .where(sql`id = ${existingFeedId}`)
        .get();
      expect(rerow?.lastAggregationStartedAt).toBeNull();

      await existingScheduler.tick();

      const { jobs: jobList } = existingQueue.listJobs({ kind: "aggregate" });
      expect(jobList.length).toBe(1);
      expect(jobList[0].payload).toEqual({ feedId: existingFeedId });

      const connection = (existingClient.getDb() as unknown as { $client: Database.Database })
        .$client;
      if (connection.open) connection.close();
    } finally {
      delete process.env.DATABASE_PATH;
      for (const suffix of ["", "-shm", "-wal"]) {
        fs.rmSync(`${existingDbPath}${suffix}`, { force: true });
      }
      fs.rmSync(priorFolder, { recursive: true, force: true });
    }
  });

  it("stamps a scheduled aggregate job with its feed's userId", async () => {
    let feedId = 0;
    let userId = "";
    client.writeTransaction((db) => {
      let user = db.select().from(schema.users).limit(1).get();
      if (!user) {
        db.insert(schema.users).values({ id: "user1", email: "user1@example.com" }).run();
        user = db.select().from(schema.users).limit(1).get();
      }
      userId = user!.id;

      const inserted = db
        .insert(schema.feeds)
        .values({
          name: "Test Feed",
          aggregator: "full_website",
          userId,
          enabled: true,
        })
        .returning({ id: schema.feeds.id })
        .get();
      feedId = inserted.id;

      const oneHourAgoSec = Math.floor((Date.now() - 3_600_000) / 1000);
      db.run(
        sql`UPDATE feeds SET last_aggregation_started_at = ${oneHourAgoSec} WHERE id = ${feedId}`,
      );
    });

    await scheduler.tick();

    const enqueued = queue.listJobs({ kind: "aggregate" }).jobs[0];
    expect(enqueued?.payload).toEqual({ feedId });
    expect(enqueued?.userId).toBe(userId);
  });

  it("never enqueues an aggregate job when the feed's updateIntervalMinutes is 0", async () => {
    let feedId = 0;
    client.writeTransaction((db) => {
      let user = db.select().from(schema.users).limit(1).get();
      if (!user) {
        db.insert(schema.users).values({ id: "user1", email: "user1@example.com" }).run();
        user = db.select().from(schema.users).limit(1).get();
      }

      const inserted = db
        .insert(schema.feeds)
        .values({
          name: "Test Feed",
          aggregator: "full_website",
          userId: user!.id,
          enabled: true,
          updateIntervalMinutes: 0,
        })
        .returning({ id: schema.feeds.id })
        .get();
      feedId = inserted.id;

      // Long overdue by any positive interval -- still must not fire.
      const longAgoSec = Math.floor((Date.now() - 30 * 24 * 3_600_000) / 1000);
      db.run(
        sql`UPDATE feeds SET last_aggregation_started_at = ${longAgoSec} WHERE id = ${feedId}`,
      );
    });

    await scheduler.tick();

    const { jobs: jobList } = queue.listJobs({ kind: "aggregate" });
    expect(jobList.length).toBe(0);
  });

  it("respects each feed's own interval independently", async () => {
    let dueFeedId = 0;
    let notDueFeedId = 0;
    client.writeTransaction((db) => {
      let user = db.select().from(schema.users).limit(1).get();
      if (!user) {
        db.insert(schema.users).values({ id: "user1", email: "user1@example.com" }).run();
        user = db.select().from(schema.users).limit(1).get();
      }

      const due = db
        .insert(schema.feeds)
        .values({
          name: "Due Feed",
          aggregator: "full_website",
          userId: user!.id,
          enabled: true,
          updateIntervalMinutes: 30,
        })
        .returning({ id: schema.feeds.id })
        .get();
      dueFeedId = due.id;

      const notDue = db
        .insert(schema.feeds)
        .values({
          name: "Not Due Feed",
          aggregator: "full_website",
          userId: user!.id,
          enabled: true,
          updateIntervalMinutes: 1440,
        })
        .returning({ id: schema.feeds.id })
        .get();
      notDueFeedId = notDue.id;

      // Both updated an hour ago: overdue for the 30-minute feed, not for the
      // 1440-minute (daily) one.
      const oneHourAgoSec = Math.floor((Date.now() - 3_600_000) / 1000);
      db.run(
        sql`UPDATE feeds SET last_aggregation_started_at = ${oneHourAgoSec} WHERE id IN (${dueFeedId}, ${notDueFeedId})`,
      );
    });

    await scheduler.tick();

    const { jobs: jobList } = queue.listJobs({ kind: "aggregate" });
    expect(jobList.map((j) => j.payload)).toEqual([{ feedId: dueFeedId }]);
    expect(jobList.some((j) => j.payload?.feedId === notDueFeedId)).toBe(false);
  });

  it("does not enqueue an overdue AI-enabled feed whose owner has no active provider", async () => {
    let feedId = 0;
    client.writeTransaction((db) => {
      let user = db.select().from(schema.users).limit(1).get();
      if (!user) {
        db.insert(schema.users).values({ id: "user1", email: "user1@example.com" }).run();
        user = db.select().from(schema.users).limit(1).get();
      }

      db.insert(schema.userSettings).values({ userId: user!.id, activeAiProvider: "" }).run();

      const inserted = db
        .insert(schema.feeds)
        .values({
          name: "Test Feed",
          aggregator: "full_website",
          userId: user!.id,
          enabled: true,
          options: { ai_translate: true },
        })
        .returning({ id: schema.feeds.id })
        .get();
      feedId = inserted.id;

      const oneHourAgoSec = Math.floor((Date.now() - 3_600_000) / 1000);
      db.run(
        sql`UPDATE feeds SET last_aggregation_started_at = ${oneHourAgoSec} WHERE id = ${feedId}`,
      );
    });

    await scheduler.tick();

    const { jobs: aggregateJobs } = queue.listJobs({ kind: "aggregate" });
    expect(aggregateJobs.some((j) => j.payload?.feedId === feedId)).toBe(false);
  });

  it("still enqueues an overdue AI-enabled feed once the owner has a working provider", async () => {
    let feedId = 0;
    client.writeTransaction((db) => {
      let user = db.select().from(schema.users).limit(1).get();
      if (!user) {
        db.insert(schema.users).values({ id: "user1", email: "user1@example.com" }).run();
        user = db.select().from(schema.users).limit(1).get();
      }

      db.insert(schema.userSettings)
        .values({ userId: user!.id, activeAiProvider: "openai", openaiEnabled: true })
        .run();

      const inserted = db
        .insert(schema.feeds)
        .values({
          name: "Test Feed",
          aggregator: "full_website",
          userId: user!.id,
          enabled: true,
          options: { ai_translate: true },
        })
        .returning({ id: schema.feeds.id })
        .get();
      feedId = inserted.id;

      const oneHourAgoSec = Math.floor((Date.now() - 3_600_000) / 1000);
      db.run(
        sql`UPDATE feeds SET last_aggregation_started_at = ${oneHourAgoSec} WHERE id = ${feedId}`,
      );
    });

    await scheduler.tick();

    const { jobs: aggregateJobs } = queue.listJobs({ kind: "aggregate" });
    expect(aggregateJobs.some((j) => j.payload?.feedId === feedId)).toBe(true);
  });

  it("enqueues daily retention job and deduplicates", async () => {
    await scheduler.tick();

    const { jobs: jobList } = queue.listJobs({ kind: "retention" });
    expect(jobList.length).toBe(1);

    await scheduler.tick();
    const { jobs: jobList2 } = queue.listJobs({ kind: "retention" });
    expect(jobList2.length).toBe(1);
  });

  it("guards against duplicate scheduler loops", () => {
    scheduler.startScheduler({ tickIntervalMs: 60_000 });
    expect(scheduler.isSchedulerRunning()).toBe(true);

    scheduler.startScheduler({ tickIntervalMs: 60_000 });
    expect(scheduler.isSchedulerRunning()).toBe(true);

    scheduler.stopScheduler();
    expect(scheduler.isSchedulerRunning()).toBe(false);
  });

  it("notifies admins when a scheduler tick throws", async () => {
    vi.spyOn(queue, "enqueue").mockImplementation(() => {
      throw new Error("enqueue exploded");
    });

    scheduler.startScheduler({ tickIntervalMs: 60_000 });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(notifyAdminsMock).toHaveBeenCalledWith(
      expect.objectContaining({ category: "scheduler" }),
    );
  });
});
