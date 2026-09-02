import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyMigrationsAt } from "@/lib/db/test-support";

vi.mock("next/server", () => import("@/test/next-server"));

describe("GET /api/v1/jobs/[id]", () => {
  let dbPath: string;
  let GET: typeof import("./route").GET;
  let createUserWithPassword: typeof import("@/lib/auth/server").createUserWithPassword;
  let createDeviceSession: typeof import("@/lib/auth/server").createDeviceSession;

  beforeEach(async () => {
    vi.resetModules();
    const stamp = `${process.pid}-${Math.random().toString(36).slice(2)}`;
    dbPath = path.join(os.tmpdir(), `yana-jobs-route-${stamp}.db`);
    applyMigrationsAt(dbPath);
    process.env.DATABASE_PATH = dbPath;
    process.env.BETTER_AUTH_SECRET = "test-secret-not-used-outside-this-file-0123456789";

    ({ createUserWithPassword, createDeviceSession } = await import("@/lib/auth/server"));
    ({ GET } = await import("./route"));
  });

  afterEach(() => fs.rmSync(dbPath, { force: true }));

  const call = (id: string, token?: string) =>
    GET(
      new Request(`https://example.com/api/v1/jobs/${id}`, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
      }),
      { params: Promise.resolve({ id }) },
    );

  it("401s with no Authorization header", async () => {
    const response = await call("1");
    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe("unauthorized");
  });

  it("returns the job's durable state for its owner", async () => {
    const owner = await createUserWithPassword({
      email: "j-owner@example.com",
      password: "correct horse battery staple",
    });
    const { token } = await createDeviceSession(owner.id, "Test");
    const { enqueue, progress } = await import("@/lib/jobs/queue");
    const jobId = enqueue("article.reload", { articleId: 7 }, { userId: owner.id });
    progress(jobId, 55);

    const response = await call(String(jobId), token);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      jobId,
      runId: null,
      kind: "article.reload",
      progress: 55,
      status: "pending",
      error: "",
      startedAt: null,
      finishedAt: null,
    });
  });

  it("404s for another user's job", async () => {
    const owner = await createUserWithPassword({
      email: "j-a@example.com",
      password: "correct horse battery staple",
    });
    const other = await createUserWithPassword({
      email: "j-b@example.com",
      password: "correct horse battery staple",
    });
    const { token } = await createDeviceSession(other.id, "Test");
    const { enqueue } = await import("@/lib/jobs/queue");
    const jobId = enqueue("article.reload", { articleId: 7 }, { userId: owner.id });

    const response = await call(String(jobId), token);
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("not_found");
  });

  it("404s for an unowned job", async () => {
    const owner = await createUserWithPassword({
      email: "j-c@example.com",
      password: "correct horse battery staple",
    });
    const { token } = await createDeviceSession(owner.id, "Test");
    const { enqueue } = await import("@/lib/jobs/queue");
    const jobId = enqueue("retention", {});

    const response = await call(String(jobId), token);
    expect(response.status).toBe(404);
  });

  it("404s for a nonexistent and for a non-numeric id", async () => {
    const owner = await createUserWithPassword({
      email: "j-d@example.com",
      password: "correct horse battery staple",
    });
    const { token } = await createDeviceSession(owner.id, "Test");

    expect((await call("999999", token)).status).toBe(404);
    expect((await call("not-a-number", token)).status).toBe(404);
  });
});
