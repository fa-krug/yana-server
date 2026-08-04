import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyMigrationsAt } from "../db/test-support";

describe("src/lib/jobs/log-capture", () => {
  let dbPath: string;
  let queue: typeof import("./queue");
  let logCapture: typeof import("./log-capture");
  let client: typeof import("../db/client");

  beforeEach(async () => {
    vi.resetModules();
    dbPath = path.join(
      os.tmpdir(),
      `yana-log-capture-${process.pid}-${Math.random().toString(36).slice(2)}.db`,
    );
    process.env.DATABASE_PATH = dbPath;
    applyMigrationsAt(dbPath);

    client = await import("../db/client");
    queue = await import("./queue");
    logCapture = await import("./log-capture");
  });

  afterEach(() => {
    delete process.env.DATABASE_PATH;
    const connection = (client.getDb() as unknown as { $client: Database.Database }).$client;
    if (connection.open) connection.close();
    for (const suffix of ["", "-shm", "-wal"]) {
      fs.rmSync(`${dbPath}${suffix}`, { force: true });
    }
  });

  it("redirects console.log to stdout lines for the active job", async () => {
    const jobId = queue.enqueue("test.job", {});

    await logCapture.runWithLogCapture(jobId, async () => {
      console.log("hello from the job");
    });

    const lines = queue.listJobLogs(jobId);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ stream: "stdout", line: "hello from the job" });
  });

  it("redirects console.error to stderr lines", async () => {
    const jobId = queue.enqueue("test.job", {});

    await logCapture.runWithLogCapture(jobId, async () => {
      console.error("oh no");
    });

    expect(queue.listJobLogs(jobId)).toEqual([
      expect.objectContaining({ stream: "stderr", line: "oh no" }),
    ]);
  });

  it("splits a multi-line console call into separate rows", async () => {
    const jobId = queue.enqueue("test.job", {});

    await logCapture.runWithLogCapture(jobId, async () => {
      console.log("line one\nline two");
    });

    expect(queue.listJobLogs(jobId).map((l) => l.line)).toEqual(["line one", "line two"]);
  });

  it("does not capture a console call made outside any active context", async () => {
    const jobId = queue.enqueue("test.job", {});

    console.log("not part of any job");

    expect(queue.listJobLogs(jobId)).toEqual([]);
  });

  it("keeps two concurrently-running jobs' output apart", async () => {
    const jobA = queue.enqueue("test.job", {});
    const jobB = queue.enqueue("test.job", {});

    const pA = logCapture.runWithLogCapture(jobA, async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      console.log("from A");
    });
    const pB = logCapture.runWithLogCapture(jobB, async () => {
      console.log("from B");
      await new Promise((resolve) => setTimeout(resolve, 40));
      console.log("from B again");
    });

    await Promise.all([pA, pB]);

    expect(queue.listJobLogs(jobA).map((l) => l.line)).toEqual(["from A"]);
    expect(queue.listJobLogs(jobB).map((l) => l.line)).toEqual(["from B", "from B again"]);
  });

  it("tees to the real console as well as persisting, when a context is active", async () => {
    // `console.log` must be spied on *before* `log-capture.ts` is imported:
    // its patch captures `original.log = console.log.bind(console)` once at
    // import time, so a spy installed afterwards would never see calls made
    // through that already-bound reference. `vi.resetModules()` plus a fresh
    // dynamic import (this file's usual pattern, one level further) is what
    // makes "before this particular import" achievable inside a test body.
    vi.resetModules();
    const logSpy = vi.spyOn(console, "log");

    try {
      const freshClient: typeof import("../db/client") = await import("../db/client");
      const freshQueue: typeof import("./queue") = await import("./queue");
      const freshLogCapture: typeof import("./log-capture") = await import("./log-capture");

      const jobId = freshQueue.enqueue("test.job", {});

      await freshLogCapture.runWithLogCapture(jobId, async () => {
        console.log("both places");
      });

      expect(logSpy).toHaveBeenCalledWith("both places");
      expect(freshQueue.listJobLogs(jobId)).toEqual([
        expect.objectContaining({ stream: "stdout", line: "both places" }),
      ]);

      const conn = (freshClient.getDb() as unknown as { $client: Database.Database }).$client;
      if (conn.open) conn.close();
    } finally {
      logSpy.mockRestore();
    }
  });

  it("does not recurse when a log-bus subscriber itself logs while persisting a line", async () => {
    const { subscribeJobLog } = await import("./log-bus");
    const jobId = queue.enqueue("test.job", {});

    // Simulates a future subscriber (e.g. the SSE route's `send()`) that
    // itself calls a patched console method. Without `als.exit()` wrapping
    // the persist/publish step, `als.getStore()` would still report this same
    // job context inside the subscriber, so this call would recurse into
    // `appendLogLine()` -> `publishJobLog()` -> this same listener, forever.
    const unsubscribe = subscribeJobLog(jobId, () => {
      console.log("subscriber side-effect log");
    });

    try {
      await logCapture.runWithLogCapture(jobId, async () => {
        console.log("original line");
      });
    } finally {
      unsubscribe();
    }

    expect(queue.listJobLogs(jobId).map((l) => l.line)).toEqual(["original line"]);
  });

  it("does not throw when the underlying log write fails", async () => {
    const jobId = queue.enqueue("test.job", {});
    const connection = (client.getDb() as unknown as { $client: Database.Database }).$client;
    connection.close();

    await expect(
      logCapture.runWithLogCapture(jobId, async () => {
        console.log("should not throw even though the database connection is closed");
      }),
    ).resolves.toBeUndefined();
  });
});
