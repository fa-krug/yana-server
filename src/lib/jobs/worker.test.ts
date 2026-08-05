import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyMigrationsAt } from "../db/test-support";

const notifyAdminsMock = vi.fn();
vi.mock("../email/error-notifications", () => ({
  notifyAdmins: notifyAdminsMock,
  notifyJobFailure: vi.fn(),
}));

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
    notifyAdminsMock.mockClear();
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

  it("logs lifecycle markers around a handler's execution, without capturing its console output", async () => {
    handlers.registerHandler("logging.job", async () => {
      console.log("this should not appear in the job's log");
    });

    const id = queue.enqueue("logging.job", {}, { maxAttempts: 1 });

    const loopPromise = worker.runWorkerLoop({ pollIntervalMs: 50 });
    await new Promise((resolve) => setTimeout(resolve, 200));
    worker.stopWorker();
    await loopPromise;

    const lines = queue.listJobLogs(id).map((l) => ({ stream: l.stream, line: l.line }));
    expect(lines).toEqual([
      { stream: "stdout", line: "job started (attempt 1/1)" },
      { stream: "stdout", line: "job completed" },
    ]);
  });

  it("logs a failed handler's full stack trace as stderr lines", async () => {
    handlers.registerHandler("failing.logged.job", async () => {
      throw new Error("kaboom");
    });

    const id = queue.enqueue("failing.logged.job", {}, { maxAttempts: 1 });

    const loopPromise = worker.runWorkerLoop({ pollIntervalMs: 50 });
    await new Promise((resolve) => setTimeout(resolve, 200));
    worker.stopWorker();
    await loopPromise;

    const lines = queue.listJobLogs(id);
    expect(lines[0]).toMatchObject({
      stream: "stdout",
      line: "job started (attempt 1/1)",
    });
    const stderrLines = lines.slice(1);
    expect(stderrLines.every((l) => l.stream === "stderr")).toBe(true);
    expect(stderrLines[0]!.line).toContain("kaboom");
    // A real Error's .stack includes a "at ..." frame beneath the message.
    expect(stderrLines.some((l) => l.line.includes("at "))).toBe(true);
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

  it("notifies admins when the worker loop crashes fatally", async () => {
    vi.spyOn(queue, "claim").mockImplementation(() => {
      throw new Error("claim exploded");
    });

    worker.startWorker();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(notifyAdminsMock).toHaveBeenCalledWith(expect.objectContaining({ category: "worker" }));
    expect(worker.isWorkerRunning()).toBe(false);
  });

  it("cancels the job, without retrying, when a handler throws JobCancelledError", async () => {
    const { JobCancelledError } = await import("./errors");
    handlers.registerHandler("cancelling.job", async () => {
      throw new JobCancelledError();
    });

    const id = queue.enqueue("cancelling.job", {}, { maxAttempts: 3 });

    const loopPromise = worker.runWorkerLoop({ pollIntervalMs: 50 });
    await new Promise((resolve) => setTimeout(resolve, 200));
    worker.stopWorker();
    await loopPromise;

    const job = queue.getJob(id);
    expect(job?.status).toBe("cancelled");
    expect(job?.attempts).toBe(1);
    expect(job?.error).toBe("");

    const lines = queue.listJobLogs(id).map((l) => l.line);
    expect(lines).toEqual(["job started (attempt 1/3)", "job cancelled"]);
  });
});
