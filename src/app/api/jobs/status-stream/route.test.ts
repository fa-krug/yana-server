import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { signInCookie } from "@/lib/auth/test-support";
import { applyMigrationsAt } from "@/lib/db/test-support";

/**
 * A request-scope stub, same pattern as `src/app/api/jobs/[id]/log-stream/route.test.ts`:
 * this route is session-cookie authenticated (`requireUserFreshRole()`), not
 * the Bearer-token style `/api/v1/**` routes use, so `next/headers` needs
 * stubbing rather than `next/server`'s `connection()`.
 */
const { requestHeaders } = vi.hoisted(() => ({ requestHeaders: { current: new Headers() } }));
vi.mock("next/headers", async () =>
  (await import("@/test/next-headers")).nextHeadersStub(requestHeaders),
);

/** The real digest `redirect()` throws; not stubbed. */
const REDIRECT = /^NEXT_REDIRECT/;

describe("GET /api/jobs/status-stream", () => {
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
    dbPath = path.join(os.tmpdir(), `yana-jobs-status-route-${stamp}.db`);
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
    ids: string,
    options: { cookie?: string; signal?: AbortSignal } = {},
  ): Promise<Response> {
    if (options.cookie) requestHeaders.current = new Headers({ cookie: options.cookie });
    const url = new URL(`http://localhost/api/jobs/status-stream?ids=${ids}`);
    return GET(new Request(url, { signal: options.signal }));
  }

  it("redirects to login when there is no session", async () => {
    await expect(get("1")).rejects.toThrow(REDIRECT);
  });

  it("sends a done event and closes immediately for an already-terminal job", async () => {
    const { id: userId, cookie } = await signedInCookie();
    const jobId = queue.enqueue("test.job", {}, { maxAttempts: 1, userId });
    queue.complete(jobId);

    const response = await get(String(jobId), { cookie });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");

    const reader = response.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toContain("event: done");
    expect(first).toContain(`"id":${jobId}`);
    expect(first).toContain('"status":"completed"');

    const second = await reader.read();
    expect(second.done).toBe(true);
  });

  it("sends a done event and closes immediately for an id that does not exist", async () => {
    const { cookie } = await signedInCookie();

    const response = await get("999999", { cookie });
    const reader = response.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toContain('"status":"gone"');

    const second = await reader.read();
    expect(second.done).toBe(true);
  });

  it("treats a job owned by a different user as already resolved, not as theirs", async () => {
    await createUserWithPassword({ ...CREDENTIALS, firstName: "A", lastName: "B" });
    const cookie = await signInCookie(auth, CREDENTIALS);
    const other = await createUserWithPassword({
      email: "owner@example.com",
      password: "correct horse battery staple",
      firstName: "O",
      lastName: "W",
    });
    const jobId = queue.enqueue("test.job", {}, { userId: other.id });
    queue.claim();

    const response = await get(String(jobId), { cookie });
    const reader = response.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toContain('"status":"gone"');

    const second = await reader.read();
    expect(second.done).toBe(true);
  });

  it("sends a done event and closes the stream when a still-running job finishes mid-connection", async () => {
    const { id: userId, cookie } = await signedInCookie();
    const jobId = queue.enqueue("test.job", {}, { userId });
    queue.claim();

    const controller = new AbortController();
    const response = await get(String(jobId), { cookie, signal: controller.signal });
    expect(response.status).toBe(200);

    const reader = response.body!.getReader();
    const readNext = reader.read();
    queue.complete(jobId);

    const event = new TextDecoder().decode((await readNext).value);
    expect(event).toContain("event: done");
    expect(event).toContain('"status":"completed"');

    const closed = await reader.read();
    expect(closed.done).toBe(true);

    controller.abort();
  });

  it("waits for every id before closing, in whatever order they finish", async () => {
    const { id: userId, cookie } = await signedInCookie();
    const firstJobId = queue.enqueue("test.job", {}, { maxAttempts: 1, userId });
    const secondJobId = queue.enqueue("test.job", {}, { maxAttempts: 1, userId });
    queue.claim();
    queue.claim();

    const controller = new AbortController();
    const response = await get(`${firstJobId},${secondJobId}`, {
      cookie,
      signal: controller.signal,
    });
    const reader = response.body!.getReader();

    const readFirst = reader.read();
    queue.fail(secondJobId, "boom");
    const firstEvent = new TextDecoder().decode((await readFirst).value);
    expect(firstEvent).toContain(`"id":${secondJobId}`);

    const readSecond = reader.read();
    queue.complete(firstJobId);
    const secondEvent = new TextDecoder().decode((await readSecond).value);
    expect(secondEvent).toContain(`"id":${firstJobId}`);

    const closed = await reader.read();
    expect(closed.done).toBe(true);

    controller.abort();
  });

  it("unsubscribes and clears the keep-alive interval when the client disconnects", async () => {
    const setIntervalSpy = vi.spyOn(global, "setInterval");
    const clearIntervalSpy = vi.spyOn(global, "clearInterval");
    const { id: userId, cookie } = await signedInCookie();
    const jobId = queue.enqueue("test.job", {}, { userId });
    queue.claim();

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

    expect(() => queue.complete(jobId)).not.toThrow();

    setIntervalSpy.mockRestore();
    clearIntervalSpy.mockRestore();
  });
});
