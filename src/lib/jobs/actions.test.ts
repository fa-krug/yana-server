import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { signInCookie } from "@/lib/auth/test-support";
import { applyMigrationsAt } from "@/lib/db/test-support";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { requestHeaders, cookieJar } = vi.hoisted(() => ({
  requestHeaders: { current: new Headers() },
  cookieJar: new Map<string, string>(),
}));

vi.mock("next/headers", async () =>
  (await import("@/test/next-headers")).nextHeadersStub(requestHeaders, cookieJar),
);

const PASSWORD = "correct horse battery staple";

describe("src/lib/jobs/actions", () => {
  let dbPath: string;
  let jobsActions: typeof import("./actions");
  let queue: typeof import("./queue");
  let auth: typeof import("@/lib/auth/server").auth;
  let createUserWithPassword: typeof import("@/lib/auth/server").createUserWithPassword;
  let client: typeof import("@/lib/db/client");

  function raw(db: unknown): Database.Database {
    return (db as { $client: Database.Database }).$client;
  }

  function requestAs(cookie: string): void {
    requestHeaders.current = new Headers({ cookie });
  }

  async function seedUser(email: string): Promise<string> {
    const user = await createUserWithPassword({
      email,
      password: PASSWORD,
      firstName: "",
      lastName: "",
      role: "user",
    });
    return user.id;
  }

  async function signInAs(email: string): Promise<void> {
    const cookie = await signInCookie(auth, { email, password: PASSWORD });
    requestAs(cookie);
    cookieJar.clear();
  }

  async function seedAdmin(email: string): Promise<string> {
    const user = await createUserWithPassword({
      email,
      password: PASSWORD,
      firstName: "",
      lastName: "",
      role: "admin",
    });
    return user.id;
  }

  beforeEach(async () => {
    vi.resetModules();
    requestHeaders.current = new Headers();
    cookieJar.clear();

    const stamp = `${process.pid}-${Math.random().toString(36).slice(2)}`;
    dbPath = path.join(os.tmpdir(), `yana-jobs-actions-${stamp}.db`);
    applyMigrationsAt(dbPath);
    process.env.DATABASE_PATH = dbPath;
    process.env.BETTER_AUTH_SECRET = "test-secret-not-used-outside-this-file-0123456789";

    ({ auth, createUserWithPassword } = await import("@/lib/auth/server"));
    jobsActions = await import("./actions");
    queue = await import("./queue");
    client = await import("@/lib/db/client");
  });

  afterEach(() => {
    delete process.env.DATABASE_PATH;
    delete process.env.BETTER_AUTH_SECRET;
    const connection = raw(client.getDb());
    if (connection.open) connection.close();
    for (const suffix of ["", "-shm", "-wal"]) {
      fs.rmSync(`${dbPath}${suffix}`, { force: true });
    }
  });

  describe("getRunStatus", () => {
    it("returns the run's status for its owner", async () => {
      const userId = await seedUser("owner@example.com");
      await signInAs("owner@example.com");
      const runId = queue.enqueueRun(userId, "feed.update", [{ feedId: 1 }, { feedId: 2 }]);

      const status = await jobsActions.getRunStatus(runId);
      expect(status).toEqual({
        status: "running",
        totalJobs: 2,
        completedJobs: 0,
        failedJobs: 0,
      });
    });

    it("returns null for a run owned by another user", async () => {
      const ownerId = await seedUser("owner@example.com");
      const runId = queue.enqueueRun(ownerId, "feed.update", [{ feedId: 1 }]);

      await seedUser("other@example.com");
      await signInAs("other@example.com");

      expect(await jobsActions.getRunStatus(runId)).toBeNull();
    });

    it("returns null for a nonexistent run id", async () => {
      await seedUser("owner@example.com");
      await signInAs("owner@example.com");

      expect(await jobsActions.getRunStatus(999_999)).toBeNull();
    });
  });

  describe("cancelJobs", () => {
    it("cancels a pending job immediately", async () => {
      const userId = await seedUser("owner@example.com");
      await signInAs("owner@example.com");
      const id = queue.enqueue("noop", {}, { userId });

      const result = await jobsActions.cancelJobs([id]);
      expect(result).toEqual({ ok: true, affected: 1 });
      expect(queue.getJob(id)?.status).toBe("cancelled");
    });

    it("asks a running job to stop", async () => {
      const userId = await seedUser("owner@example.com");
      await signInAs("owner@example.com");
      const id = queue.enqueue("noop", {}, { userId });
      queue.claim();

      const result = await jobsActions.cancelJobs([id]);
      expect(result).toEqual({ ok: true, affected: 1 });
      expect(queue.getJob(id)?.status).toBe("cancelling");
    });

    it("does not affect another user's job", async () => {
      const ownerId = await seedUser("owner@example.com");
      const id = queue.enqueue("noop", {}, { userId: ownerId });

      await seedUser("other@example.com");
      await signInAs("other@example.com");

      const result = await jobsActions.cancelJobs([id]);
      expect(result).toEqual({ ok: true, affected: 0 });
      expect(queue.getJob(id)?.status).toBe("pending");
    });

    it("lets an admin cancel another user's job", async () => {
      const ownerId = await seedUser("owner@example.com");
      const id = queue.enqueue("noop", {}, { userId: ownerId });

      await seedAdmin("admin@example.com");
      await signInAs("admin@example.com");

      const result = await jobsActions.cancelJobs([id]);
      expect(result).toEqual({ ok: true, affected: 1 });
      expect(queue.getJob(id)?.status).toBe("cancelled");
    });

    it("returns affected: 0 and touches nothing for an empty id list", async () => {
      await seedUser("owner@example.com");
      await signInAs("owner@example.com");
      expect(await jobsActions.cancelJobs([])).toEqual({ ok: true, affected: 0 });
    });
  });

  describe("deleteJobs", () => {
    it("deletes a completed job, and cascades its log lines", async () => {
      const userId = await seedUser("owner@example.com");
      await signInAs("owner@example.com");
      const id = queue.enqueue("noop", {}, { userId, maxAttempts: 1 });
      queue.claim();
      queue.appendLogLine(id, "stdout", "hello");
      queue.complete(id);

      const result = await jobsActions.deleteJobs([id]);
      expect(result).toEqual({ ok: true, deleted: 1, stopping: [] });
      expect(queue.getJob(id)).toBeNull();
      expect(queue.listJobLogs(id)).toEqual([]);
    });

    it("deletes a pending job outright, without requesting cancellation", async () => {
      const userId = await seedUser("owner@example.com");
      await signInAs("owner@example.com");
      const id = queue.enqueue("noop", {}, { userId });

      const result = await jobsActions.deleteJobs([id]);
      expect(result).toEqual({ ok: true, deleted: 1, stopping: [] });
      expect(queue.getJob(id)).toBeNull();
    });

    it("requests cancellation on a running job instead of deleting it immediately", async () => {
      const userId = await seedUser("owner@example.com");
      await signInAs("owner@example.com");
      const id = queue.enqueue("noop", {}, { userId });
      queue.claim();

      const result = await jobsActions.deleteJobs([id]);
      expect(result).toEqual({ ok: true, deleted: 0, stopping: [id] });
      expect(queue.getJob(id)?.status).toBe("cancelling");
    });

    it("does not delete another user's job", async () => {
      const ownerId = await seedUser("owner@example.com");
      const id = queue.enqueue("noop", {}, { userId: ownerId });

      await seedUser("other@example.com");
      await signInAs("other@example.com");

      const result = await jobsActions.deleteJobs([id]);
      expect(result).toEqual({ ok: true, deleted: 0, stopping: [] });
      expect(queue.getJob(id)).not.toBeNull();
    });

    it("returns deleted: 0 and touches nothing for an empty id list", async () => {
      await seedUser("owner@example.com");
      await signInAs("owner@example.com");
      expect(await jobsActions.deleteJobs([])).toEqual({ ok: true, deleted: 0, stopping: [] });
    });
  });
});
