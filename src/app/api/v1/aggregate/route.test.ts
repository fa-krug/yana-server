import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyMigrationsAt } from "@/lib/db/test-support";

describe("POST /api/v1/aggregate", () => {
  let dbPath: string;
  let POST: typeof import("./route").POST;
  let createUserWithPassword: typeof import("@/lib/auth/server").createUserWithPassword;
  let createDeviceSession: typeof import("@/lib/auth/server").createDeviceSession;
  let client: typeof import("@/lib/db/client");
  let schema: typeof import("@/lib/db/schema");

  beforeEach(async () => {
    // A fresh module registry per test: `getDb()` is a lazy module-level
    // singleton (see `src/lib/db/client.ts`), so without this the second
    // test in this file would silently keep querying the first test's
    // already-closed temp database rather than the one just created below.
    vi.resetModules();
    const stamp = `${process.pid}-${Math.random().toString(36).slice(2)}`;
    dbPath = path.join(os.tmpdir(), `yana-aggregate-route-${stamp}.db`);
    applyMigrationsAt(dbPath);
    process.env.DATABASE_PATH = dbPath;
    process.env.BETTER_AUTH_SECRET = "test-secret-not-used-outside-this-file-0123456789";

    ({ createUserWithPassword, createDeviceSession } = await import("@/lib/auth/server"));
    client = await import("@/lib/db/client");
    schema = await import("@/lib/db/schema");
    ({ POST } = await import("./route"));
  });

  afterEach(() => fs.rmSync(dbPath, { force: true }));

  function aggregateRequest(token?: string) {
    return POST(
      new Request("https://example.com/api/v1/aggregate", {
        method: "POST",
        headers: token ? { authorization: `Bearer ${token}` } : undefined,
      }),
    );
  }

  it("401s with no Authorization header", async () => {
    const response = await aggregateRequest();
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error.code).toBe("unauthorized");
  });

  it("creates a run with one job per enabled feed, excluding disabled and other users' feeds", async () => {
    const owner = await createUserWithPassword({
      email: "o@example.com",
      password: "correct horse battery staple",
    });
    const other = await createUserWithPassword({
      email: "other@example.com",
      password: "correct horse battery staple",
    });
    const { token } = await createDeviceSession(owner.id, "Test");

    client.writeTransaction((tx) => {
      tx.insert(schema.feeds)
        .values({
          name: "A",
          aggregator: "full_website",
          identifier: "https://a",
          userId: owner.id,
          enabled: true,
        })
        .run();
      tx.insert(schema.feeds)
        .values({
          name: "B",
          aggregator: "full_website",
          identifier: "https://b",
          userId: owner.id,
          enabled: true,
        })
        .run();
      // Disabled -- must be excluded from the owner's run.
      tx.insert(schema.feeds)
        .values({
          name: "C",
          aggregator: "full_website",
          identifier: "https://c",
          userId: owner.id,
          enabled: false,
        })
        .run();
      // Another user's enabled feed -- must never be counted against the
      // caller's run, even though it would otherwise match the same query
      // shape (enabled = true).
      tx.insert(schema.feeds)
        .values({
          name: "D",
          aggregator: "full_website",
          identifier: "https://d",
          userId: other.id,
          enabled: true,
        })
        .run();
    });

    const response = await aggregateRequest(token);

    expect(response.status).toBe(202);
    const body = await response.json();
    expect(typeof body.runId).toBe("number");

    const run = client
      .getDb()
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.id, body.runId))
      .get();
    expect(run?.userId).toBe(owner.id);
    expect(run?.totalJobs).toBe(2); // disabled feed and other user's feed excluded
    expect(run?.status).toBe("running");

    const childJobs = client
      .getDb()
      .select()
      .from(schema.jobs)
      .where(eq(schema.jobs.runId, body.runId))
      .all();
    expect(childJobs).toHaveLength(2);
    expect(childJobs.every((j) => j.kind === "aggregate")).toBe(true);
    const feedIds = childJobs.map((j) => (j.payload as { feedId: number }).feedId).sort();
    // Only the owner's two enabled feeds, never the other user's.
    expect(feedIds).toHaveLength(2);
  });

  it("creates an already-completed run with zero jobs when the caller has no enabled feeds", async () => {
    const owner = await createUserWithPassword({
      email: "o2@example.com",
      password: "correct horse battery staple",
    });
    const { token } = await createDeviceSession(owner.id, "Test");

    const response = await aggregateRequest(token);

    expect(response.status).toBe(202);
    const body = await response.json();
    // `enqueueRun` treats an empty payload list as legal and creates the run
    // already "completed" rather than returning no run at all (see the
    // doc comment on `enqueueRun` in `src/lib/jobs/queue.ts`) -- there is no
    // child job to ever flip it out of "running", so it never would.
    expect(typeof body.runId).toBe("number");

    const run = client
      .getDb()
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.id, body.runId))
      .get();
    expect(run?.status).toBe("completed");
    expect(run?.totalJobs).toBe(0);
    expect(run?.finishedAt).not.toBeNull();

    const childJobs = client
      .getDb()
      .select()
      .from(schema.jobs)
      .where(eq(schema.jobs.runId, body.runId))
      .all();
    expect(childJobs).toHaveLength(0);
  });
});
