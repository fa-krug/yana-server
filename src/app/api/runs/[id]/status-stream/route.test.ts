import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { signInCookie } from "@/lib/auth/test-support";
import { applyMigrationsAt } from "@/lib/db/test-support";

/**
 * A request-scope stub, same pattern as `src/app/api/jobs/[id]/log-stream/route.test.ts`:
 * this route is session-cookie authenticated (`requireUser()`), not the
 * Bearer-token style `/api/v1/**` routes use, so `next/headers` needs
 * stubbing rather than `next/server`'s `connection()`.
 */
const { requestHeaders } = vi.hoisted(() => ({ requestHeaders: { current: new Headers() } }));
vi.mock("next/headers", async () =>
  (await import("@/test/next-headers")).nextHeadersStub(requestHeaders),
);

/** The real digest `redirect()` throws; not stubbed. */
const REDIRECT = /^NEXT_REDIRECT/;

describe("GET /api/runs/[id]/status-stream", () => {
  let dbPath: string;
  let GET: typeof import("./route").GET;
  let auth: typeof import("@/lib/auth/server").auth;
  let createUserWithPassword: typeof import("@/lib/auth/server").createUserWithPassword;
  let queue: typeof import("@/lib/jobs/queue");

  const CREDENTIALS = { email: "a@example.com", password: "correct horse battery staple" };

  beforeEach(async () => {
    vi.resetModules();
    requestHeaders.current = new Headers();

    const stamp = `${process.pid}-${Math.random().toString(36).slice(2)}`;
    dbPath = path.join(os.tmpdir(), `yana-run-status-route-${stamp}.db`);
    applyMigrationsAt(dbPath);
    process.env.DATABASE_PATH = dbPath;
    process.env.BETTER_AUTH_SECRET = "test-secret-not-used-outside-this-file-0123456789";

    ({ auth, createUserWithPassword } = await import("@/lib/auth/server"));
    queue = await import("@/lib/jobs/queue");
    ({ GET } = await import("./route"));
  });

  afterEach(() => {
    delete process.env.DATABASE_PATH;
    delete process.env.BETTER_AUTH_SECRET;
    fs.rmSync(dbPath, { force: true });
    for (const suffix of ["-shm", "-wal"]) {
      fs.rmSync(`${dbPath}${suffix}`, { force: true });
    }
  });

  async function signedInCookie(): Promise<{ id: string; cookie: string }> {
    const user = await createUserWithPassword({ ...CREDENTIALS, firstName: "A", lastName: "B" });
    return { id: user.id, cookie: await signInCookie(auth, CREDENTIALS) };
  }

  function get(
    runId: string,
    options: { cookie?: string; signal?: AbortSignal } = {},
  ): Promise<Response> {
    if (options.cookie) requestHeaders.current = new Headers({ cookie: options.cookie });
    const url = new URL(`http://localhost/api/runs/${runId}/status-stream`);
    return GET(new Request(url, { signal: options.signal }), {
      params: Promise.resolve({ id: runId }),
    });
  }

  it("redirects to login when there is no session", async () => {
    await expect(get("1")).rejects.toThrow(REDIRECT);
  });

  it("404s for a run id that does not exist", async () => {
    const { cookie } = await signedInCookie();
    const response = await get("999999", { cookie });
    expect(response.status).toBe(404);
  });

  it("404s for a run owned by a different user", async () => {
    await createUserWithPassword({ ...CREDENTIALS, firstName: "A", lastName: "B" });
    const cookie = await signInCookie(auth, CREDENTIALS);
    const other = await createUserWithPassword({
      email: "owner@example.com",
      password: "correct horse battery staple",
      firstName: "O",
      lastName: "W",
    });
    const runId = queue.enqueueRun(other.id, "test.job", [{}]);

    const response = await get(String(runId), { cookie });
    expect(response.status).toBe(404);
  });

  it("sends a status event and closes immediately for an already-terminal run", async () => {
    const { id: userId, cookie } = await signedInCookie();
    const runId = queue.enqueueRun(userId, "test.job", []);

    const response = await get(String(runId), { cookie });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");

    const reader = response.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toContain("event: status");
    expect(first).toContain('"status":"completed"');

    const second = await reader.read();
    expect(second.done).toBe(true);
  });

  it("sends a status event and closes the stream when a still-running run finishes mid-connection", async () => {
    const { id: userId, cookie } = await signedInCookie();
    const runId = queue.enqueueRun(userId, "test.job", [{}]);
    const job = queue.claim();

    const controller = new AbortController();
    const response = await get(String(runId), { cookie, signal: controller.signal });
    expect(response.status).toBe(200);

    const reader = response.body!.getReader();
    const readNext = reader.read();
    queue.complete(job!.id);

    const event = new TextDecoder().decode((await readNext).value);
    expect(event).toContain("event: status");
    expect(event).toContain('"status":"completed"');

    const closed = await reader.read();
    expect(closed.done).toBe(true);

    controller.abort();
  });

  it("ignores another run's events on the same user's shared subscription", async () => {
    const { id: userId, cookie } = await signedInCookie();
    const otherRunId = queue.enqueueRun(userId, "test.job", [{}]);
    const runId = queue.enqueueRun(userId, "test.job", [{}, {}]);
    expect(otherRunId).not.toBe(runId);

    const controller = new AbortController();
    const response = await get(String(runId), { cookie, signal: controller.signal });
    const reader = response.body!.getReader();

    const readNext = reader.read();
    // Finishes the other run entirely first -- if the route's subscription
    // filtered by userId alone (not also runId), this would be what the
    // reader below observes.
    const otherJob = queue.claim();
    expect(otherJob!.runId).toBe(otherRunId);
    queue.complete(otherJob!.id);

    const job = queue.claim();
    expect(job!.runId).toBe(runId);
    queue.complete(job!.id);

    const event = new TextDecoder().decode((await readNext).value);
    // `runId`'s run has 2 jobs; only one has completed so far -- if this
    // instead reflects `otherRunId`'s run (1 job, already fully completed),
    // it would read "completedJobs":1 and "status":"completed" instead.
    expect(event).toContain('"totalJobs":2');
    expect(event).toContain('"completedJobs":1');
    expect(event).toContain('"status":"running"');

    controller.abort();
    await reader.cancel();
  });

  it("unsubscribes and clears the keep-alive interval when the client disconnects", async () => {
    const setIntervalSpy = vi.spyOn(global, "setInterval");
    const clearIntervalSpy = vi.spyOn(global, "clearInterval");
    const { id: userId, cookie } = await signedInCookie();
    const runId = queue.enqueueRun(userId, "test.job", [{}]);

    const controller = new AbortController();
    const response = await get(String(runId), { cookie, signal: controller.signal });
    const reader = response.body!.getReader();

    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    const intervalId = setIntervalSpy.mock.results[0]!.value;

    controller.abort();
    await reader.cancel();
    await vi.waitFor(() => {
      expect(clearIntervalSpy).toHaveBeenCalledWith(intervalId);
    });

    setIntervalSpy.mockRestore();
    clearIntervalSpy.mockRestore();
  });
});
