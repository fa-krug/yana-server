import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyMigrationsAt } from "../db/test-support";

describe("src/lib/jobs/queue", () => {
  let dbPath: string;
  let queue: typeof import("./queue");
  let client: typeof import("../db/client");

  beforeEach(async () => {
    vi.resetModules();
    dbPath = path.join(
      os.tmpdir(),
      `yana-queue-${process.pid}-${Math.random().toString(36).slice(2)}.db`,
    );
    process.env.DATABASE_PATH = dbPath;
    applyMigrationsAt(dbPath);

    client = await import("../db/client");
    queue = await import("./queue");
  });

  afterEach(() => {
    delete process.env.DATABASE_PATH;
    const connection = (client.getDb() as unknown as { $client: Database.Database }).$client;
    if (connection.open) connection.close();
    for (const suffix of ["", "-shm", "-wal"]) {
      fs.rmSync(`${dbPath}${suffix}`, { force: true });
    }
  });

  describe("enqueue", () => {
    it("creates a job with default options", () => {
      const id = queue.enqueue("test.job", { foo: "bar" });
      expect(id).toBeGreaterThan(0);

      const job = queue.getJob(id);
      expect(job).not.toBeNull();
      expect(job?.kind).toBe("test.job");
      expect(job?.payload).toEqual({ foo: "bar" });
      expect(job?.status).toBe("pending");
      expect(job?.attempts).toBe(0);
      expect(job?.maxAttempts).toBe(3);
    });

    it("respects custom runAt and maxAttempts", () => {
      const future = new Date(Date.now() + 60_000);
      const id = queue.enqueue("test.job", { a: 1 }, { runAt: future, maxAttempts: 5 });

      const job = queue.getJob(id);
      expect(job?.maxAttempts).toBe(5);
      expect(new Date(job!.runAt).getTime()).toBeGreaterThanOrEqual(future.getTime() - 1000);
    });
  });

  describe("claim", () => {
    it("never hands the same job to two callers", () => {
      const id = queue.enqueue("noop", {});
      const first = queue.claim();
      const second = queue.claim();

      expect(first?.id).toBe(id);
      expect(second).toBeNull();
    });

    it("skips a job whose runAt is in the future", () => {
      queue.enqueue("noop", {}, { runAt: new Date(Date.now() + 60_000) });
      expect(queue.claim()).toBeNull();
    });

    it("claims the oldest eligible job first", () => {
      const older = queue.enqueue("noop", { n: 1 }, { runAt: new Date(Date.now() - 2000) });
      const newer = queue.enqueue("noop", { n: 2 }, { runAt: new Date(Date.now() - 1000) });

      expect(queue.claim()?.id).toBe(older);
      expect(queue.claim()?.id).toBe(newer);
    });

    it("resets a job orphaned by a crash", () => {
      const id = queue.enqueue("noop", {});
      queue.claim();

      const resetCount = queue.resetOrphaned(new Date(Date.now() + 1000));
      expect(resetCount).toBe(1);

      const reclaimed = queue.claim();
      expect(reclaimed?.id).toBe(id);
    });
  });

  describe("fail", () => {
    it("backs off and retries below maxAttempts", () => {
      const id = queue.enqueue("noop", {}, { maxAttempts: 3 });
      const claimed = queue.claim();
      expect(claimed?.id).toBe(id);

      queue.fail(id, "temporary error");

      const job = queue.getJob(id);
      expect(job?.status).toBe("pending");
      expect(job?.error).toBe("temporary error");
      expect(new Date(job!.runAt).getTime()).toBeGreaterThan(Date.now());
    });

    it("marks failed at maxAttempts and keeps the error", () => {
      const id = queue.enqueue("noop", {}, { maxAttempts: 1 });
      queue.claim();

      queue.fail(id, "fatal error");

      const job = queue.getJob(id);
      expect(job?.status).toBe("failed");
      expect(job?.error).toBe("fatal error");
    });
  });

  describe("complete & progress", () => {
    it("marks job as completed", () => {
      const id = queue.enqueue("noop", {});
      queue.claim();

      queue.complete(id);

      const job = queue.getJob(id);
      expect(job?.status).toBe("completed");
      expect(job?.progress).toBe(100);
      expect(job?.finishedAt).not.toBeNull();
    });

    it("updates progress", () => {
      const id = queue.enqueue("noop", {});
      queue.claim();

      queue.progress(id, 45);

      const job = queue.getJob(id);
      expect(job?.progress).toBe(45);
    });
  });
});
