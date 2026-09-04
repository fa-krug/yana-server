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

  it("runs a job enqueued at PRIORITY_IMMEDIATE before older, lower-priority jobs already queued", async () => {
    const order: number[] = [];
    handlers.registerHandler("test.job", async (job) => {
      order.push(job.id);
    });

    const older1 = queue.enqueue("test.job", { n: 1 }, { runAt: new Date(Date.now() - 2000) });
    const older2 = queue.enqueue("test.job", { n: 2 }, { runAt: new Date(Date.now() - 1000) });
    const urgent = queue.enqueue(
      "test.job",
      { n: 3 },
      { runAt: new Date(), priority: queue.PRIORITY_IMMEDIATE },
    );

    const loopPromise = worker.runWorkerLoop({ pollIntervalMs: 50 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    worker.stopWorker();
    await loopPromise;

    expect(order).toEqual([urgent, older1, older2]);
  });

  it("fails job immediately, without retrying, if no handler is registered", async () => {
    // A missing handler is deterministic: the registry is populated at module
    // load and never grows at runtime. This used to leave the job `pending`
    // and burn all three attempts over an exponential back-off before showing
    // the operator the message it already had on the first attempt.
    const id = queue.enqueue("unhandled.job", {});

    const loopPromise = worker.runWorkerLoop({ pollIntervalMs: 50 });
    await new Promise((resolve) => setTimeout(resolve, 200));
    worker.stopWorker();
    await loopPromise;

    const job = queue.getJob(id);
    expect(job?.status).toBe("failed");
    expect(job?.attempts).toBe(1);
    expect(job?.maxAttempts).toBe(3);
    expect(job?.finishedAt).not.toBeNull();
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

  it("requests cancellation, but does not fail or abandon the handler, when it exceeds its time budget", async () => {
    // A handler with no isCancelRequested() checkpoint (most don't have one --
    // only aggregate.ts and retention.ts do) can't react to the request, so it
    // keeps running exactly as it would have before -- the fix is that the
    // worker no longer lies about the job being "failed" out from under it
    // while that happens, and does not claim a second, concurrent execution
    // of the same job in the meantime.
    handlers.registerHandler("slow.job", async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });

    const id = queue.enqueue("slow.job", {}, { maxAttempts: 1 });

    const loopPromise = worker.runWorkerLoop({ pollIntervalMs: 20, timeoutMs: 100 });

    // Well past the 100ms budget, but before the 300ms handler finishes:
    // cancellation has been requested, yet the job is still genuinely running
    // -- not "failed", and nothing else could have claimed it.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(queue.getJob(id)?.status).toBe("cancelling");

    // Let the handler actually finish.
    await new Promise((resolve) => setTimeout(resolve, 200));
    worker.stopWorker();
    await loopPromise;

    const job = queue.getJob(id);
    expect(job?.status).toBe("completed");

    const lines = queue.listJobLogs(id).map((l) => l.line);
    expect(lines).toEqual([
      "job started (attempt 1/1)",
      "job exceeded its 100ms time budget -- requesting cancellation",
      "job completed (after exceeding its time budget)",
    ]);
  });

  it("cancels rather than fails a job that notices the cancellation request after exceeding its time budget", async () => {
    handlers.registerHandler("cooperative.slow.job", async (job) => {
      const { JobCancelledError } = await import("./errors");
      while (!queue.isCancelRequested(job.id)) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new JobCancelledError();
    });

    const id = queue.enqueue("cooperative.slow.job", {}, { maxAttempts: 3 });

    const loopPromise = worker.runWorkerLoop({ pollIntervalMs: 20, timeoutMs: 50 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    worker.stopWorker();
    await loopPromise;

    const job = queue.getJob(id);
    expect(job?.status).toBe("cancelled");
    expect(job?.attempts).toBe(1);
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

  it("runs jobs from two loops concurrently, not serially", async () => {
    // A single loop cannot claim job 2 until job 1's handler has returned, so
    // if job 2 starts while job 1 is still blocked mid-handler, that proves
    // two independent claim/execute loops are really running side by side --
    // not just that startWorker() accepted a `concurrency` option.
    const started: number[] = [];
    let releaseFirst: () => void = () => {};
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    handlers.registerHandler("test.job", async (job) => {
      started.push(job.payload.n as number);
      if (job.payload.n === 1) {
        await firstBlocked;
      }
    });

    const id1 = queue.enqueue("test.job", { n: 1 });
    const id2 = queue.enqueue("test.job", { n: 2 });

    const loop1 = worker.runWorkerLoop({ pollIntervalMs: 20 });
    const loop2 = worker.runWorkerLoop({ pollIntervalMs: 20 });

    await vi.waitFor(() => expect(started).toContain(2), { timeout: 1000 });
    // Job 1's handler is still awaiting `firstBlocked` at this point -- job 2
    // only got to run because loop2 claimed it independently of loop1.
    expect(queue.getJob(id1)?.status).toBe("running");

    releaseFirst();
    worker.stopWorker();
    await Promise.all([loop1, loop2]);

    expect(queue.getJob(id1)?.status).toBe("completed");
    expect(queue.getJob(id2)?.status).toBe("completed");
  });

  it("startWorker() honors an explicit concurrency, running that many loops", async () => {
    const started: number[] = [];
    let releaseAll: () => void = () => {};
    const blocked = new Promise<void>((resolve) => {
      releaseAll = resolve;
    });

    handlers.registerHandler("test.job", async (job) => {
      started.push(job.id);
      await blocked;
    });

    const ids = [
      queue.enqueue("test.job", {}),
      queue.enqueue("test.job", {}),
      queue.enqueue("test.job", {}),
    ];

    worker.startWorker({ pollIntervalMs: 20, concurrency: 3 });

    // All three jobs claimed and blocked in their handlers at once -- only
    // possible with three independent loops, since one loop can hold at most
    // one job "running" at a time.
    await vi.waitFor(() => expect(started).toHaveLength(3), { timeout: 1000 });
    expect(new Set(started)).toEqual(new Set(ids));

    releaseAll();
    worker.stopWorker();
    await new Promise((resolve) => setTimeout(resolve, 100));

    for (const id of ids) {
      expect(queue.getJob(id)?.status).toBe("completed");
    }
  });

  it("reads its loop count from WORKER_CONCURRENCY when no explicit option is given", async () => {
    process.env.WORKER_CONCURRENCY = "2";

    const started: number[] = [];
    let releaseAll: () => void = () => {};
    const blocked = new Promise<void>((resolve) => {
      releaseAll = resolve;
    });

    handlers.registerHandler("test.job", async (job) => {
      started.push(job.id);
      await blocked;
    });

    const ids = [queue.enqueue("test.job", {}), queue.enqueue("test.job", {})];

    worker.startWorker({ pollIntervalMs: 20 });

    await vi.waitFor(() => expect(started).toHaveLength(2), { timeout: 1000 });
    expect(new Set(started)).toEqual(new Set(ids));

    releaseAll();
    worker.stopWorker();
    await new Promise((resolve) => setTimeout(resolve, 100));
    delete process.env.WORKER_CONCURRENCY;
  });

  it("falls back to DEFAULT_WORKER_CONCURRENCY (4) when WORKER_CONCURRENCY is not a valid positive integer", async () => {
    process.env.WORKER_CONCURRENCY = "not-a-number";

    const started: number[] = [];
    let releaseAll: () => void = () => {};
    const blocked = new Promise<void>((resolve) => {
      releaseAll = resolve;
    });

    handlers.registerHandler("test.job", async (job) => {
      started.push(job.id);
      await blocked;
    });

    const ids = Array.from({ length: 4 }, () => queue.enqueue("test.job", {}));
    // A fifth job stays untouched -- proving the fallback is exactly 4 loops,
    // not "invalid input means unbounded".
    const fifth = queue.enqueue("test.job", {});

    worker.startWorker({ pollIntervalMs: 20 });
    await vi.waitFor(() => expect(started).toHaveLength(4), { timeout: 1000 });
    expect(new Set(started)).toEqual(new Set(ids));
    expect(queue.getJob(fifth)?.status).toBe("pending");

    releaseAll();
    worker.stopWorker();
    await new Promise((resolve) => setTimeout(resolve, 100));
    delete process.env.WORKER_CONCURRENCY;
  });

  it("notifies admins once, not once per loop, when every loop crashes at once", async () => {
    vi.spyOn(queue, "claim").mockImplementation(() => {
      throw new Error("claim exploded");
    });

    worker.startWorker({ concurrency: 3 });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(notifyAdminsMock).toHaveBeenCalledTimes(1);
    expect(worker.isWorkerRunning()).toBe(false);
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

  it("jitters the idle poll interval so concurrent loops do not wake in lockstep", async () => {
    const delays: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      fn: () => void,
      ms?: number,
    ) => {
      if (typeof ms === "number") delays.push(ms);
      return realSetTimeout(fn, 1);
    }) as typeof globalThis.setTimeout);

    const loopPromise = worker.runWorkerLoop({ pollIntervalMs: 100 });
    await new Promise((resolve) => realSetTimeout(resolve, 60));
    worker.stopWorker();
    await loopPromise;
    spy.mockRestore();

    const idleDelays = delays.filter((ms) => ms > 0);
    expect(idleDelays.length).toBeGreaterThan(2);
    // Every sleep sits inside the jitter band...
    for (const ms of idleDelays) {
      expect(ms).toBeGreaterThanOrEqual(75);
      expect(ms).toBeLessThan(125);
    }
    // ...and they are not all the same value, which is the whole point.
    expect(new Set(idleDelays).size).toBeGreaterThan(1);
  });
});
