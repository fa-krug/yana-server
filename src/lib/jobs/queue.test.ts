import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { articles, feeds, jobs, users } from "../db/schema";
import { applyMigrationsAt } from "../db/test-support";

describe("src/lib/jobs/queue", () => {
  let dbPath: string;
  let queue: typeof import("./queue");
  let client: typeof import("../db/client");
  let events: typeof import("../api/events");

  function seedUserAndReturnId(): string {
    const id = `user-${Math.random().toString(36).slice(2)}`;
    client
      .getDb()
      .insert(users)
      .values({ id, email: `${id}@example.com` })
      .run();
    return id;
  }

  /** A feed + article owned by `userId`, for the `article.reload` job kind. */
  function seedArticleAndReturnId(userId: string): number {
    const db = client.getDb();
    const feed = db
      .insert(feeds)
      .values({ name: "Feed", userId })
      .returning({ id: feeds.id })
      .get();
    const article = db
      .insert(articles)
      .values({ name: "Article", identifier: "a1", date: new Date(), feedId: feed.id })
      .returning({ id: articles.id })
      .get();
    return article.id;
  }

  beforeEach(async () => {
    vi.resetModules();
    dbPath = path.join(
      os.tmpdir(),
      `yana-queue-${process.pid}-${Math.random().toString(36).slice(2)}.db`,
    );
    process.env.DATABASE_PATH = dbPath;
    applyMigrationsAt(dbPath);

    client = await import("../db/client");
    events = await import("../api/events");
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

  describe("enqueueRun / run tracking", () => {
    it("creates a run row with totalJobs matching the payload count", () => {
      const userId = seedUserAndReturnId();
      const runId = queue.enqueueRun(userId, "aggregate", [{ feedId: 1 }, { feedId: 2 }]);

      const run = queue.getRun(runId);
      expect(run?.totalJobs).toBe(2);
      expect(run?.completedJobs).toBe(0);
      expect(run?.failedJobs).toBe(0);
      expect(run?.status).toBe("running");
      expect(run?.userId).toBe(userId);

      const createdJobs = client.getDb().select().from(jobs).where(eq(jobs.runId, runId)).all();
      expect(createdJobs).toHaveLength(2);
      expect(createdJobs.every((j) => j.kind === "aggregate")).toBe(true);
      expect(createdJobs.map((j) => j.payload)).toEqual([{ feedId: 1 }, { feedId: 2 }]);
    });

    it("creates an already-completed run when given an empty payload list", () => {
      const userId = seedUserAndReturnId();
      const runId = queue.enqueueRun(userId, "aggregate", []);

      const run = queue.getRun(runId);
      expect(run?.totalJobs).toBe(0);
      // No child job will ever complete/fail to drive bumpRunCounters(), so
      // an empty run must be born terminal rather than stuck "running" forever.
      expect(run?.status).toBe("completed");
      expect(run?.finishedAt).not.toBeNull();

      const createdJobs = client.getDb().select().from(jobs).where(eq(jobs.runId, runId)).all();
      expect(createdJobs).toHaveLength(0);
    });

    it("getRun returns null for an unknown id", () => {
      expect(queue.getRun(999_999)).toBeNull();
    });

    it("marks the run completed once every child job completes", () => {
      const userId = seedUserAndReturnId();
      const runId = queue.enqueueRun(userId, "aggregate", [{ feedId: 1 }, { feedId: 2 }]);
      const childJobs = client.getDb().select().from(jobs).where(eq(jobs.runId, runId)).all();

      queue.complete(childJobs[0].id);
      let run = queue.getRun(runId);
      expect(run?.status).toBe("running");
      expect(run?.completedJobs).toBe(1);
      expect(run?.finishedAt).toBeNull();

      queue.complete(childJobs[1].id);
      run = queue.getRun(runId);
      expect(run?.status).toBe("completed");
      expect(run?.completedJobs).toBe(2);
      expect(run?.finishedAt).not.toBeNull();
    });

    it("marks the run failed if any child job fails", () => {
      const userId = seedUserAndReturnId();
      const runId = queue.enqueueRun(userId, "aggregate", [{ feedId: 1 }, { feedId: 2 }]);

      // Claim and complete the first job normally.
      const first = queue.claim();
      expect(first).not.toBeNull();
      queue.complete(first!.id);

      // Claim the second job (bumps attempts to 1), then pin maxAttempts to 1
      // so the very next fail() call is already terminal.
      const second = queue.claim();
      expect(second).not.toBeNull();
      client.getDb().update(jobs).set({ maxAttempts: 1 }).where(eq(jobs.id, second!.id)).run();

      queue.fail(second!.id, "boom");

      const run = queue.getRun(runId);
      expect(run?.status).toBe("failed");
      expect(run?.completedJobs).toBe(1);
      expect(run?.failedJobs).toBe(1);
      expect(run?.finishedAt).not.toBeNull();
    });

    it("does not touch any run when a plain job (no runId) completes or fails", () => {
      const id = queue.enqueue("noop", {}, { maxAttempts: 1 });
      queue.claim();

      // Should not throw despite job.runId being null.
      expect(() => queue.complete(id)).not.toThrow();

      const id2 = queue.enqueue("noop", {}, { maxAttempts: 1 });
      queue.claim();
      expect(() => queue.fail(id2, "boom")).not.toThrow();
    });
  });

  describe("job/run events", () => {
    it("publishes job and run events when a run's child job completes", () => {
      const userId = seedUserAndReturnId();
      const runId = queue.enqueueRun(userId, "aggregate", [{ feedId: 1 }, { feedId: 2 }]);
      const childJobs = client.getDb().select().from(jobs).where(eq(jobs.runId, runId)).all();

      const heard: unknown[] = [];
      const unsubscribe = events.subscribeUserEvents(userId, (event) => heard.push(event));

      queue.complete(childJobs[0].id);
      unsubscribe();

      expect(heard).toEqual([
        {
          type: "job",
          payload: {
            jobId: childJobs[0].id,
            runId,
            kind: "aggregate",
            status: "completed",
            progress: 100,
          },
        },
        {
          type: "run",
          payload: { runId, status: "running", totalJobs: 2, completedJobs: 1, failedJobs: 0 },
        },
      ]);
    });

    it("publishes job and run events when a run's child job fails terminally", () => {
      const userId = seedUserAndReturnId();
      const runId = queue.enqueueRun(userId, "aggregate", [{ feedId: 1 }, { feedId: 2 }]);

      const first = queue.claim();
      expect(first).not.toBeNull();
      queue.complete(first!.id);

      const second = queue.claim();
      expect(second).not.toBeNull();
      client.getDb().update(jobs).set({ maxAttempts: 1 }).where(eq(jobs.id, second!.id)).run();

      const heard: unknown[] = [];
      const unsubscribe = events.subscribeUserEvents(userId, (event) => heard.push(event));

      queue.fail(second!.id, "boom");
      unsubscribe();

      expect(heard).toEqual([
        {
          type: "job",
          payload: { jobId: second!.id, runId, kind: "aggregate", status: "failed", progress: 0 },
        },
        {
          type: "run",
          payload: { runId, status: "failed", totalJobs: 2, completedJobs: 1, failedJobs: 1 },
        },
      ]);
    });

    it("resolves the owning user via articles->feeds and publishes a job event when a standalone article.reload job completes", () => {
      const userId = seedUserAndReturnId();
      const articleId = seedArticleAndReturnId(userId);
      const id = queue.enqueue("article.reload", { articleId });

      const heard: unknown[] = [];
      const unsubscribe = events.subscribeUserEvents(userId, (event) => heard.push(event));

      queue.complete(id);
      unsubscribe();

      expect(heard).toEqual([
        {
          type: "job",
          payload: {
            jobId: id,
            runId: null,
            kind: "article.reload",
            status: "completed",
            progress: 100,
          },
        },
      ]);
    });

    it("resolves the owning user via articles->feeds and publishes a job event when a standalone article.reload job fails terminally", () => {
      const userId = seedUserAndReturnId();
      const articleId = seedArticleAndReturnId(userId);
      const id = queue.enqueue("article.reload", { articleId }, { maxAttempts: 1 });
      queue.claim();

      const heard: unknown[] = [];
      const unsubscribe = events.subscribeUserEvents(userId, (event) => heard.push(event));

      queue.fail(id, "boom");
      unsubscribe();

      expect(heard).toEqual([
        {
          type: "job",
          payload: {
            jobId: id,
            runId: null,
            kind: "article.reload",
            status: "failed",
            progress: 0,
          },
        },
      ]);
    });

    it("publishes nothing for a job with no runId and a kind other than article.reload", () => {
      const userId = seedUserAndReturnId();
      const heard: unknown[] = [];
      const unsubscribe = events.subscribeUserEvents(userId, (event) => heard.push(event));

      const completedId = queue.enqueue("feed.logo", {}, { maxAttempts: 1 });
      queue.claim();
      queue.complete(completedId);

      const failedId = queue.enqueue("feed.logo", {}, { maxAttempts: 1 });
      queue.claim();
      queue.fail(failedId, "boom");

      unsubscribe();
      expect(heard).toHaveLength(0);
    });
  });
});
