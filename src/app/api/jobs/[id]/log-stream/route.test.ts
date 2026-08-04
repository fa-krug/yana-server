import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { signInCookie } from "@/lib/auth/test-support";
import { applyMigrationsAt } from "@/lib/db/test-support";

/**
 * A request-scope stub, same pattern as `src/app/media/avatars/[userId]/route.test.ts`:
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

describe("GET /api/jobs/[id]/log-stream", () => {
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
    dbPath = path.join(os.tmpdir(), `yana-job-log-route-${stamp}.db`);
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

  async function signedInCookie(): Promise<string> {
    await createUserWithPassword({ ...CREDENTIALS, firstName: "A", lastName: "B" });
    return signInCookie(auth, CREDENTIALS);
  }

  function get(
    jobId: string,
    options: { cookie?: string; after?: string; signal?: AbortSignal } = {},
  ): Promise<Response> {
    if (options.cookie) requestHeaders.current = new Headers({ cookie: options.cookie });
    const url = new URL(`http://localhost/api/jobs/${jobId}/log-stream`);
    if (options.after) url.searchParams.set("after", options.after);
    return GET(new Request(url, { signal: options.signal }), {
      params: Promise.resolve({ id: jobId }),
    });
  }

  it("redirects to login when there is no session", async () => {
    const jobId = queue.enqueue("test.job", {});
    await expect(get(String(jobId))).rejects.toThrow(REDIRECT);
  });

  it("404s for a job id that does not exist", async () => {
    const cookie = await signedInCookie();
    const response = await get("999999", { cookie });
    expect(response.status).toBe(404);
  });

  it("streams persisted lines after the given cursor, then a live line", async () => {
    const cookie = await signedInCookie();
    const jobId = queue.enqueue("test.job", {});
    const first = queue.appendLogLine(jobId, "stdout", "one");
    queue.appendLogLine(jobId, "stdout", "two");

    const controller = new AbortController();
    const response = await get(String(jobId), {
      cookie,
      after: String(first.id),
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");

    const reader = response.body!.getReader();
    const backfill = new TextDecoder().decode((await reader.read()).value);
    expect(backfill).toContain('"line":"two"');
    expect(backfill).not.toContain('"line":"one"');

    const readNext = reader.read();
    queue.appendLogLine(jobId, "stdout", "live line");
    const live = new TextDecoder().decode((await readNext).value);
    expect(live).toContain('"line":"live line"');

    controller.abort();
    await reader.cancel();
  });

  it("sends an end event and closes immediately for an already-terminal job", async () => {
    const cookie = await signedInCookie();
    const jobId = queue.enqueue("test.job", {}, { maxAttempts: 1 });
    queue.appendLogLine(jobId, "stdout", "done thing");
    queue.complete(jobId);

    const response = await get(String(jobId), { cookie });
    const reader = response.body!.getReader();

    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toContain('"line":"done thing"');

    const second = await reader.read();
    expect(new TextDecoder().decode(second.value)).toContain("event: end");

    const third = await reader.read();
    expect(third.done).toBe(true);
  });

  it("sends an end event and closes the stream when a still-running job finishes mid-connection", async () => {
    const cookie = await signedInCookie();
    const jobId = queue.enqueue("test.job", {});
    queue.claim();

    const controller = new AbortController();
    const response = await get(String(jobId), { cookie, signal: controller.signal });
    expect(response.status).toBe(200);

    const reader = response.body!.getReader();
    const readEnd = reader.read();
    queue.complete(jobId);

    const end = new TextDecoder().decode((await readEnd).value);
    expect(end).toContain("event: end");
    expect(end).toContain('"status":"completed"');

    const closed = await reader.read();
    expect(closed.done).toBe(true);

    controller.abort();
  });

  it("sends a failed end event and closes the stream when a still-running job fails terminally mid-connection", async () => {
    const cookie = await signedInCookie();
    const jobId = queue.enqueue("test.job", {}, { maxAttempts: 1 });
    queue.claim();

    const controller = new AbortController();
    const response = await get(String(jobId), { cookie, signal: controller.signal });

    const reader = response.body!.getReader();
    const readEnd = reader.read();
    queue.fail(jobId, "boom");

    const end = new TextDecoder().decode((await readEnd).value);
    expect(end).toContain("event: end");
    expect(end).toContain('"status":"failed"');

    const closed = await reader.read();
    expect(closed.done).toBe(true);

    controller.abort();
  });

  it("unsubscribes and clears the keep-alive interval when the client disconnects", async () => {
    const setIntervalSpy = vi.spyOn(global, "setInterval");
    const clearIntervalSpy = vi.spyOn(global, "clearInterval");
    const cookie = await signedInCookie();
    const jobId = queue.enqueue("test.job", {});

    const controller = new AbortController();
    const response = await get(String(jobId), { cookie, signal: controller.signal });
    const reader = response.body!.getReader();

    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    const intervalId = setIntervalSpy.mock.results[0]!.value;

    controller.abort();
    await reader.cancel();
    await vi.waitFor(() => {
      expect(clearIntervalSpy).toHaveBeenCalledWith(intervalId);
    });

    expect(() => queue.appendLogLine(jobId, "stdout", "after disconnect")).not.toThrow();

    setIntervalSpy.mockRestore();
    clearIntervalSpy.mockRestore();
  });
});
