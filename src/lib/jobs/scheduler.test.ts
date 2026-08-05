import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyMigrationsAt } from "../db/test-support";

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
});
