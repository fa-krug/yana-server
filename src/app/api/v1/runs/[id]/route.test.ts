import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyMigrationsAt } from "@/lib/db/test-support";

vi.mock("next/server", () => import("@/test/next-server"));

describe("GET /api/v1/runs/[id]", () => {
  let dbPath: string;
  let GET: typeof import("./route").GET;
  let createUserWithPassword: typeof import("@/lib/auth/server").createUserWithPassword;
  let createDeviceSession: typeof import("@/lib/auth/server").createDeviceSession;

  beforeEach(async () => {
    // A fresh module registry per test: `getDb()` is a lazy module-level
    // singleton (see `src/lib/db/client.ts`), so without this the second
    // test in this file would silently keep querying the first test's
    // already-closed temp database rather than the one just created below.
    vi.resetModules();
    const stamp = `${process.pid}-${Math.random().toString(36).slice(2)}`;
    dbPath = path.join(os.tmpdir(), `yana-runs-route-${stamp}.db`);
    applyMigrationsAt(dbPath);
    process.env.DATABASE_PATH = dbPath;
    process.env.BETTER_AUTH_SECRET = "test-secret-not-used-outside-this-file-0123456789";

    ({ createUserWithPassword, createDeviceSession } = await import("@/lib/auth/server"));
    ({ GET } = await import("./route"));
  });

  afterEach(() => fs.rmSync(dbPath, { force: true }));

  it("401s with no Authorization header", async () => {
    const response = await GET(new Request("https://example.com/api/v1/runs/1"), {
      params: Promise.resolve({ id: "1" }),
    });
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error.code).toBe("unauthorized");
  });

  it("404s for a run belonging to another user", async () => {
    const owner = await createUserWithPassword({
      email: "o@example.com",
      password: "correct horse battery staple",
    });
    const other = await createUserWithPassword({
      email: "o2@example.com",
      password: "correct horse battery staple",
    });
    const { token } = await createDeviceSession(other.id, "Test");
    const { enqueueRun } = await import("@/lib/jobs/queue");
    const runId = enqueueRun(owner.id, "aggregate", [{ feedId: 1 }]);

    const response = await GET(
      new Request(`https://example.com/api/v1/runs/${runId}`, {
        headers: { authorization: `Bearer ${token}` },
      }),
      { params: Promise.resolve({ id: String(runId) }) },
    );
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error.code).toBe("not_found");
  });

  it("404s for a nonexistent run id", async () => {
    const owner = await createUserWithPassword({
      email: "o-missing@example.com",
      password: "correct horse battery staple",
    });
    const { token } = await createDeviceSession(owner.id, "Test");

    const response = await GET(
      new Request("https://example.com/api/v1/runs/999999", {
        headers: { authorization: `Bearer ${token}` },
      }),
      { params: Promise.resolve({ id: "999999" }) },
    );
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error.code).toBe("not_found");
  });

  it("404s for a non-numeric run id", async () => {
    const owner = await createUserWithPassword({
      email: "o-nan@example.com",
      password: "correct horse battery staple",
    });
    const { token } = await createDeviceSession(owner.id, "Test");

    const response = await GET(
      new Request("https://example.com/api/v1/runs/not-a-number", {
        headers: { authorization: `Bearer ${token}` },
      }),
      { params: Promise.resolve({ id: "not-a-number" }) },
    );
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error.code).toBe("not_found");
  });

  it("returns run counters for the owner", async () => {
    const owner = await createUserWithPassword({
      email: "o3@example.com",
      password: "correct horse battery staple",
    });
    const { token } = await createDeviceSession(owner.id, "Test");
    const { enqueueRun } = await import("@/lib/jobs/queue");
    const runId = enqueueRun(owner.id, "aggregate", [{ feedId: 1 }, { feedId: 2 }]);

    const response = await GET(
      new Request(`https://example.com/api/v1/runs/${runId}`, {
        headers: { authorization: `Bearer ${token}` },
      }),
      { params: Promise.resolve({ id: String(runId) }) },
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      runId,
      status: "running",
      totalJobs: 2,
      completedJobs: 0,
      failedJobs: 0,
    });
  });

  it("await connection() is the first statement, before requireApiUser()", async () => {
    // A garbage bearer token would normally 401 -- but if requireApiUser()
    // ran before connection(), a route that dropped the connection() call
    // could not be told apart from one that has it just by hitting this
    // endpoint. This test instead pins the *source order* directly, since
    // that is the actual invariant the self-review asks for and no black-box
    // request can observe it.
    const routeSource = fs.readFileSync(path.join(__dirname, "route.ts"), "utf8");
    const connectionIndex = routeSource.indexOf("connection()");
    const requireApiUserIndex = routeSource.indexOf("requireApiUser(");
    expect(connectionIndex).toBeGreaterThan(-1);
    expect(requireApiUserIndex).toBeGreaterThan(-1);
    expect(connectionIndex).toBeLessThan(requireApiUserIndex);
  });

  it("reports 0 progress for a run whose jobs have not finished", async () => {
    const owner = await createUserWithPassword({
      email: "o-progress@example.com",
      password: "correct horse battery staple",
    });
    const { token } = await createDeviceSession(owner.id, "Test");
    const { enqueueRun } = await import("@/lib/jobs/queue");
    const runId = enqueueRun(owner.id, "aggregate", [{ feedId: 1 }, { feedId: 2 }]);

    const response = await GET(
      new Request(`https://example.com/api/v1/runs/${runId}`, {
        headers: { authorization: `Bearer ${token}` },
      }),
      { params: Promise.resolve({ id: String(runId) }) },
    );
    const body = await response.json();
    expect(body.progress).toBe(0);
  });

  it("reports the percentage of finished jobs, counting failures", async () => {
    const owner = await createUserWithPassword({
      email: "o-progress2@example.com",
      password: "correct horse battery staple",
    });
    const { token } = await createDeviceSession(owner.id, "Test");
    const { enqueueRun, claim, complete, fail } = await import("@/lib/jobs/queue");
    const { getDb } = await import("@/lib/db/client");
    const { jobs } = await import("@/lib/db/schema");
    const { eq } = await import("drizzle-orm");
    const runId = enqueueRun(owner.id, "aggregate", [
      { feedId: 1 },
      { feedId: 2 },
      { feedId: 3 },
      { feedId: 4 },
    ]);

    const first = claim();
    complete(first!.id);
    const second = claim();
    // enqueueRun's jobs default to maxAttempts: 3, so a single fail() call
    // would only schedule a retry, not settle the job -- pin maxAttempts to
    // 1 so this fail() is already terminal, matching queue.test.ts's own
    // convention for forcing an immediate failure.
    getDb().update(jobs).set({ maxAttempts: 1 }).where(eq(jobs.id, second!.id)).run();
    fail(second!.id, "boom");

    const response = await GET(
      new Request(`https://example.com/api/v1/runs/${runId}`, {
        headers: { authorization: `Bearer ${token}` },
      }),
      { params: Promise.resolve({ id: String(runId) }) },
    );
    const body = await response.json();
    expect(body.progress).toBe(50);
    expect(body.completedJobs).toBe(1);
    expect(body.failedJobs).toBe(1);
  });
});
