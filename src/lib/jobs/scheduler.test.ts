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

      // Force updatedAt via raw SQL to bypass Drizzle's $onUpdate
      const oneHourAgoSec = Math.floor((Date.now() - 3_600_000) / 1000);
      db.run(sql`UPDATE feeds SET updated_at = ${oneHourAgoSec} WHERE id = ${feedId}`);
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
      db.run(sql`UPDATE feeds SET updated_at = ${oneHourAgoSec} WHERE id = ${feedId}`);
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
      db.run(sql`UPDATE feeds SET updated_at = ${oneHourAgoSec} WHERE id = ${feedId}`);
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
      db.run(sql`UPDATE feeds SET updated_at = ${oneHourAgoSec} WHERE id = ${feedId}`);
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
      db.run(sql`UPDATE feeds SET updated_at = ${longAgoSec} WHERE id = ${feedId}`);
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
        sql`UPDATE feeds SET updated_at = ${oneHourAgoSec} WHERE id IN (${dueFeedId}, ${notDueFeedId})`,
      );
    });

    await scheduler.tick();

    const { jobs: jobList } = queue.listJobs({ kind: "aggregate" });
    expect(jobList.map((j) => j.payload)).toEqual([{ feedId: dueFeedId }]);
    expect(jobList.some((j) => j.payload?.feedId === notDueFeedId)).toBe(false);
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
