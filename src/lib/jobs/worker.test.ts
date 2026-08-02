import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyMigrationsAt } from "../db/test-support";

describe("src/lib/jobs/worker", () => {
  let dbPath: string;
  let queue: typeof import("./queue");
  let worker: typeof import("./worker");
  let handlers: typeof import("./handlers");
  let client: typeof import("../db/client");

  beforeEach(async () => {
    vi.resetModules();
    dbPath = path.join(
      os.tmpdir(),
      `yana-worker-${process.pid}-${Math.random().toString(36).slice(2)}.db`,
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

  it("claims, executes registered handler, and completes job", async () => {
    let executed = false;
    handlers.registerHandler("test.job", async (job) => {
      executed = true;
      expect(job.payload).toEqual({ message: "hello" });
    });

    const id = queue.enqueue("test.job", { message: "hello" });

    // Run one iteration of worker loop asynchronously
    const loopPromise = worker.runWorkerLoop({ pollIntervalMs: 50 });

    // Give it time to process
    await new Promise((resolve) => setTimeout(resolve, 200));
    worker.stopWorker();
    await loopPromise;

    expect(executed).toBe(true);
    const job = queue.getJob(id);
    expect(job?.status).toBe("completed");
  });

  it("fails job if no handler is registered", async () => {
    const id = queue.enqueue("unhandled.job", {});

    const loopPromise = worker.runWorkerLoop({ pollIntervalMs: 50 });
    await new Promise((resolve) => setTimeout(resolve, 200));
    worker.stopWorker();
    await loopPromise;

    const job = queue.getJob(id);
    expect(job?.status).toBe("pending"); // Will backoff & stay pending because maxAttempts > 1
    expect(job?.error).toContain("No handler registered");
  });

  it("fails job if handler throws an error", async () => {
    handlers.registerHandler("failing.job", async () => {
      throw new Error("Job processing failed");
    });

    const id = queue.enqueue("failing.job", {}, { maxAttempts: 1 });

    const loopPromise = worker.runWorkerLoop({ pollIntervalMs: 50 });
    await new Promise((resolve) => setTimeout(resolve, 200));
    worker.stopWorker();
    await loopPromise;

    const job = queue.getJob(id);
    expect(job?.status).toBe("failed");
    expect(job?.error).toBe("Job processing failed");
  });

  it("enforces job timeout", async () => {
    handlers.registerHandler("slow.job", async () => {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    });

    const id = queue.enqueue("slow.job", {}, { maxAttempts: 1 });

    const loopPromise = worker.runWorkerLoop({ pollIntervalMs: 50, timeoutMs: 100 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    worker.stopWorker();
    await loopPromise;

    const job = queue.getJob(id);
    expect(job?.status).toBe("failed");
    expect(job?.error).toContain("timed out");
  });

  it("guards against starting multiple worker loops", () => {
    worker.startWorker();
    expect(worker.isWorkerRunning()).toBe(true);

    // Call startWorker again (should be no-op)
    worker.startWorker();
    expect(worker.isWorkerRunning()).toBe(true);

    worker.stopWorker();
    expect(worker.isWorkerRunning()).toBe(false);
  });
});
