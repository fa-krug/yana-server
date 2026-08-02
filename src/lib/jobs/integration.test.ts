import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyMigrationsAt } from "../db/test-support";

describe("Phase 12 Integration & Process Restart Safety", () => {
  let dbPath: string;
  let queue: typeof import("./queue");
  let worker: typeof import("./worker");
  let handlers: typeof import("./handlers");
  let client: typeof import("../db/client");

  beforeEach(async () => {
    vi.resetModules();
    dbPath = path.join(
      os.tmpdir(),
      `yana-integ-${process.pid}-${Math.random().toString(36).slice(2)}.db`,
    );
    process.env.DATABASE_PATH = dbPath;
    applyMigrationsAt(dbPath);

    client = await import("../db/client");
    queue = await import("./queue");
    handlers = await import("./handlers");
    worker = await import("./worker");

    handlers.clearHandlers();
  });

  afterEach(() => {
    worker.stopWorker();
    handlers.clearHandlers();
    delete process.env.DATABASE_PATH;
    const connection = (client.getDb() as unknown as { $client: Database.Database }).$client;
    if (connection.open) connection.close();
    for (const suffix of ["", "-shm", "-wal"]) {
      fs.rmSync(`${dbPath}${suffix}`, { force: true });
    }
  });

  it("enqueues 20 jobs, recovers from crash mid-run, runs all jobs to completion", async () => {
    const runCounts = new Map<number, number>();

    handlers.registerHandler("restart.test.job", async (job) => {
      const idx = Number(job.payload.idx);
      runCounts.set(idx, (runCounts.get(idx) || 0) + 1);
    });

    const jobIds: number[] = [];
    for (let i = 1; i <= 20; i++) {
      jobIds.push(queue.enqueue("restart.test.job", { idx: i }, { maxAttempts: 3 }));
    }

    expect(jobIds.length).toBe(20);

    // Claim 5 jobs without completing them (simulating orphaned 'running' jobs during crash)
    for (let i = 0; i < 5; i++) {
      queue.claim();
    }

    // Process crashes and restarts -> startup resets orphaned running rows
    const resetCount = queue.resetOrphaned(new Date(Date.now() + 10_000));
    expect(resetCount).toBe(5);

    // Now start worker loop to process all 20 jobs
    const loopPromise = worker.runWorkerLoop({ pollIntervalMs: 20 });
    await new Promise((resolve) => setTimeout(resolve, 800));
    worker.stopWorker();
    await loopPromise;

    // Verify all 20 jobs reach completed status
    for (const id of jobIds) {
      const job = queue.getJob(id);
      expect(job?.status).toBe("completed");
    }

    // Verify none were lost
    const { total } = queue.listJobs({ kind: "restart.test.job" });
    expect(total).toBe(20);
  });
});
