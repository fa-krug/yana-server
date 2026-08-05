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

    it("finalizes an orphaned cancelling job as cancelled, rather than resuming it as pending", () => {
      const id = queue.enqueue("noop", {});
      queue.claim();
      queue.requestCancel(id); // -> "cancelling"

      const resetCount = queue.resetOrphaned(new Date(Date.now() + 1000));

      // The return value keeps counting only the running -> pending branch,
      // unchanged from before this task -- src/lib/jobs/integration.test.ts
      // depends on that exact count.
      expect(resetCount).toBe(0);
      expect(queue.getJob(id)?.status).toBe("cancelled");
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

    it("clears a stale error once a job that failed once later completes", () => {
      // A job that times out, backs off, and then succeeds on retry used to keep displaying
      // its earlier failure message forever -- a "completed" job that still reads as broken.
      const id = queue.enqueue("noop", {}, { maxAttempts: 3 });
      queue.claim();
      queue.fail(id, "temporary error");
      expect(queue.getJob(id)?.error).toBe("temporary error");

      // fail() backs the retry off into the future; force it claimable now rather than
      // asserting through a real minute-long wait.
      client
        .getDb()
        .update(jobs)
        .set({ runAt: new Date(Date.now() - 1000) })
        .where(eq(jobs.id, id))
        .run();

      const reclaimed = queue.claim();
      expect(reclaimed?.id).toBe(id);
      expect(reclaimed?.error).toBe("");

      queue.complete(id);
      expect(queue.getJob(id)?.error).toBe("");
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

  describe("job ownership", () => {
    it("enqueue() stores an explicit userId when given one", () => {
      const userId = seedUserAndReturnId();
      const id = queue.enqueue("test.job", {}, { userId });
      expect(queue.getJob(id)?.userId).toBe(userId);
    });

    it("enqueue() leaves userId null when none is given", () => {
      const id = queue.enqueue("test.job", {});
      expect(queue.getJob(id)?.userId).toBeNull();
    });

    it("enqueueRun() stamps every job it creates with the run's userId", () => {
      const userId = seedUserAndReturnId();
      const runId = queue.enqueueRun(userId, "aggregate", [{ feedId: 1 }, { feedId: 2 }]);
      const { jobs: jobList } = queue.listJobs({});
      const runJobs = jobList.filter((j) => j.runId === runId);
      expect(runJobs).toHaveLength(2);
      expect(runJobs.every((j) => j.userId === userId)).toBe(true);
    });

    it("listJobs() filters by userId when given one", () => {
      const userId1 = seedUserAndReturnId();
      const userId2 = seedUserAndReturnId();
      queue.enqueue("test.job", {}, { userId: userId1 });
      queue.enqueue("test.job", {}, { userId: userId2 });
      queue.enqueue("test.job", {}); // no owner

      const forUser1 = queue.listJobs({ userId: userId1 });
      expect(forUser1.total).toBe(1);
      expect(forUser1.jobs[0]!.userId).toBe(userId1);
    });

    it("listJobs() with no userId returns every job regardless of owner", () => {
      const userId1 = seedUserAndReturnId();
      const userId2 = seedUserAndReturnId();
      queue.enqueue("test.job", {}, { userId: userId1 });
      queue.enqueue("test.job", {}, { userId: userId2 });
      queue.enqueue("test.job", {});

      expect(queue.listJobs({}).total).toBe(3);
    });
  });

  describe("appendLogLine / listJobLogs", () => {
    it("persists a line and returns it back from listJobLogs", () => {
      const jobId = queue.enqueue("test.job", {});

      const row = queue.appendLogLine(jobId, "stdout", "hello");

      expect(row).not.toBeNull();
      expect(row!.jobId).toBe(jobId);
      expect(row!.stream).toBe("stdout");
      expect(row!.line).toBe("hello");

      const lines = queue.listJobLogs(jobId);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toEqual(row);
    });

    it("does not throw when the underlying write fails, and returns null", () => {
      const jobId = queue.enqueue("test.job", {});
      const connection = (client.getDb() as unknown as { $client: Database.Database }).$client;
      connection.close();

      expect(() => queue.appendLogLine(jobId, "stdout", "should not throw")).not.toThrow();
      expect(queue.appendLogLine(jobId, "stdout", "still should not throw")).toBeNull();
    });

    it("orders lines by id and respects the afterId cursor", () => {
      const jobId = queue.enqueue("test.job", {});
      const first = queue.appendLogLine(jobId, "stdout", "one");
      queue.appendLogLine(jobId, "stdout", "two");
      const third = queue.appendLogLine(jobId, "stdout", "three");

      expect(queue.listJobLogs(jobId).map((l) => l.line)).toEqual(["one", "two", "three"]);
      expect(queue.listJobLogs(jobId, first!.id).map((l) => l.line)).toEqual(["two", "three"]);
      expect(queue.listJobLogs(jobId, third!.id)).toEqual([]);
    });

    it("keeps different jobs' lines apart", () => {
      const jobA = queue.enqueue("test.job", {});
      const jobB = queue.enqueue("test.job", {});
      queue.appendLogLine(jobA, "stdout", "a-line");
      queue.appendLogLine(jobB, "stdout", "b-line");

      expect(queue.listJobLogs(jobA).map((l) => l.line)).toEqual(["a-line"]);
      expect(queue.listJobLogs(jobB).map((l) => l.line)).toEqual(["b-line"]);
    });

    it("publishes on the job log bus when a line is appended", async () => {
      const { subscribeJobLog } = await import("./log-bus");
      const jobId = queue.enqueue("test.job", {});
      const received: string[] = [];
      const unsubscribe = subscribeJobLog(jobId, (line) => received.push(line.line));

      queue.appendLogLine(jobId, "stderr", "boom");

      expect(received).toEqual(["boom"]);
      unsubscribe();
    });

    it("still returns the persisted row when a publishJobLog subscriber throws", async () => {
      const { subscribeJobLog } = await import("./log-bus");
      const jobId = queue.enqueue("test.job", {});
      const unsubscribe = subscribeJobLog(jobId, () => {
        throw new Error("simulated subscriber failure");
      });

      // The insert already succeeded by the time the subscriber throws, so a
      // broken live-update listener must not turn a real write into a false
      // "the write failed" signal (null) for the caller.
      const row = queue.appendLogLine(jobId, "stdout", "line one");
      unsubscribe();

      expect(row).not.toBeNull();
      expect(row!.line).toBe("line one");
      expect(queue.listJobLogs(jobId).map((l) => l.line)).toEqual(["line one"]);
    });
  });

  describe("job terminal notifications", () => {
    it("publishes a completed terminal notification when complete() runs", async () => {
      const { subscribeJobTerminal } = await import("./log-bus");
      const id = queue.enqueue("noop", {});
      queue.claim();

      const heard: unknown[] = [];
      const unsubscribe = subscribeJobTerminal(id, (status) => heard.push(status));

      queue.complete(id);
      unsubscribe();

      expect(heard).toEqual(["completed"]);
    });

    it("publishes a failed terminal notification when fail() exhausts maxAttempts", async () => {
      const { subscribeJobTerminal } = await import("./log-bus");
      const id = queue.enqueue("noop", {}, { maxAttempts: 1 });
      queue.claim();

      const heard: unknown[] = [];
      const unsubscribe = subscribeJobTerminal(id, (status) => heard.push(status));

      queue.fail(id, "fatal error");
      unsubscribe();

      expect(heard).toEqual(["failed"]);
    });

    it("publishes no terminal notification when fail() only backs off for a retry", async () => {
      const { subscribeJobTerminal } = await import("./log-bus");
      const id = queue.enqueue("noop", {}, { maxAttempts: 3 });
      queue.claim();

      const heard: unknown[] = [];
      const unsubscribe = subscribeJobTerminal(id, (status) => heard.push(status));

      queue.fail(id, "temporary error");
      unsubscribe();

      expect(heard).toEqual([]);
    });

    it("survives a throwing terminal subscriber without corrupting the job it just completed", async () => {
      const { subscribeJobTerminal } = await import("./log-bus");
      const id = queue.enqueue("noop", {});
      queue.claim();

      // Simulates the SSE route's real failure mode: its terminal subscriber
      // calls send(), which does controller.enqueue() -- and enqueue() throws
      // once the controller is already closed.
      const unsubscribe = subscribeJobTerminal(id, () => {
        throw new Error("controller is already closed");
      });

      // Mirrors runWorkerLoop's own try/catch shape: if complete() let this
      // escape, the worker loop's catch would call fail() on the very job
      // that just succeeded, flipping "completed" back to "failed" and
      // double-counting its parent run's counters.
      try {
        queue.complete(id);
      } catch (err) {
        queue.fail(id, err instanceof Error ? err : String(err));
      }

      unsubscribe();

      const job = queue.getJob(id);
      expect(job?.status).toBe("completed");
      expect(job?.progress).toBe(100);
    });

    it("survives a throwing terminal subscriber without corrupting a job that just failed terminally", async () => {
      const { subscribeJobTerminal } = await import("./log-bus");
      const id = queue.enqueue("noop", {}, { maxAttempts: 1 });
      queue.claim();

      const unsubscribe = subscribeJobTerminal(id, () => {
        throw new Error("controller is already closed");
      });

      expect(() => queue.fail(id, "fatal error")).not.toThrow();
      unsubscribe();

      const job = queue.getJob(id);
      expect(job?.status).toBe("failed");
      expect(job?.error).toBe("fatal error");
    });
  });

  describe("requestCancel", () => {
    it("cancels a pending job immediately, without claiming it first", () => {
      const id = queue.enqueue("noop", {});

      const outcome = queue.requestCancel(id);
      expect(outcome).toBe("cancelled");

      const job = queue.getJob(id);
      expect(job?.status).toBe("cancelled");
      expect(job?.finishedAt).not.toBeNull();
    });

    it("asks a running job to stop, without marking it cancelled yet", () => {
      const id = queue.enqueue("noop", {});
      queue.claim();

      const outcome = queue.requestCancel(id);
      expect(outcome).toBe("cancelling");

      const job = queue.getJob(id);
      expect(job?.status).toBe("cancelling");
      expect(job?.finishedAt).toBeNull();
    });

    it("is a no-op against an already-terminal job", () => {
      const id = queue.enqueue("noop", {});
      queue.claim();
      queue.complete(id);

      const outcome = queue.requestCancel(id);
      expect(outcome).toBe("unchanged");
      expect(queue.getJob(id)?.status).toBe("completed");
    });

    it("is a no-op for a job id that does not exist", () => {
      expect(queue.requestCancel(999_999)).toBe("unchanged");
    });
  });

  describe("isCancelRequested", () => {
    it("is true only once a running job has been asked to stop", () => {
      const id = queue.enqueue("noop", {});
      queue.claim();
      expect(queue.isCancelRequested(id)).toBe(false);

      queue.requestCancel(id);
      expect(queue.isCancelRequested(id)).toBe(true);
    });
  });

  describe("cancelled", () => {
    it("marks a job cancelled, bumps its run's failedJobs counter, and publishes a terminal event", async () => {
      const { subscribeJobTerminal } = await import("./log-bus");
      const userId = seedUserAndReturnId();
      const runId = queue.enqueueRun(userId, "noop", [{}]);
      const [job] = client.getDb().select().from(jobs).where(eq(jobs.runId, runId)).all();
      queue.claim();

      const heard: unknown[] = [];
      const unsubscribe = subscribeJobTerminal(job!.id, (status) => heard.push(status));

      queue.cancelled(job!.id);
      unsubscribe();

      const updated = queue.getJob(job!.id);
      expect(updated?.status).toBe("cancelled");
      expect(updated?.finishedAt).not.toBeNull();

      const run = queue.getRun(runId);
      expect(run?.failedJobs).toBe(1);
      expect(heard).toEqual(["cancelled"]);
    });
  });
});
