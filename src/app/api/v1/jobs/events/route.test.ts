import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyMigrationsAt } from "@/lib/db/test-support";

// `connection()` throws when called outside Next's own request lifecycle,
// which a bare `await GET(...)` in a unit test never establishes -- see
// `src/test/next-server.ts`.
vi.mock("next/server", () => import("@/test/next-server"));

describe("GET /api/v1/jobs/events", () => {
  let dbPath: string;
  let GET: typeof import("./route").GET;
  let createUserWithPassword: typeof import("@/lib/auth/server").createUserWithPassword;
  let createDeviceSession: typeof import("@/lib/auth/server").createDeviceSession;
  let publishUserEvent: typeof import("@/lib/api/events").publishUserEvent;

  beforeEach(async () => {
    // A fresh module registry per test: `getDb()` is a lazy module-level
    // singleton, and `src/lib/api/events.ts`'s `EventEmitter` is one too --
    // without this, a listener subscribed in one test could still be
    // attached (and firing) in the next.
    vi.resetModules();
    const stamp = `${process.pid}-${Math.random().toString(36).slice(2)}`;
    dbPath = path.join(os.tmpdir(), `yana-sse-route-${stamp}.db`);
    applyMigrationsAt(dbPath);
    process.env.DATABASE_PATH = dbPath;
    process.env.BETTER_AUTH_SECRET = "test-secret-not-used-outside-this-file-0123456789";

    ({ createUserWithPassword, createDeviceSession } = await import("@/lib/auth/server"));
    ({ publishUserEvent } = await import("@/lib/api/events"));
    ({ GET } = await import("./route"));
  });

  afterEach(() => fs.rmSync(dbPath, { force: true }));

  function eventsRequest(token?: string, signal?: AbortSignal) {
    return GET(
      new Request("https://example.com/api/v1/jobs/events", {
        headers: token ? { authorization: `Bearer ${token}` } : undefined,
        signal,
      }),
    );
  }

  it("401s with no Authorization header, as a normal JSON error -- not a hanging stream", async () => {
    const response = await eventsRequest();
    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).not.toBe("text/event-stream");
    const body = await response.json();
    expect(body.error.code).toBe("unauthorized");
  });

  it("streams a published event as an SSE frame", async () => {
    const user = await createUserWithPassword({
      email: "a@example.com",
      password: "correct horse battery staple",
    });
    const { token } = await createDeviceSession(user.id, "Test");

    const controller = new AbortController();
    const response = await eventsRequest(token, controller.signal);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");

    const reader = response.body!.getReader();
    const readNext = reader.read();

    publishUserEvent(user.id, {
      type: "job",
      payload: {
        jobId: 1,
        runId: null,
        kind: "article.reload",
        status: "completed",
        progress: 100,
      },
    });

    const { done, value } = await readNext;
    expect(done).toBe(false);
    const text = new TextDecoder().decode(value);
    expect(text).toContain("event: job");
    expect(text).toContain('"jobId":1');

    controller.abort();
    await reader.cancel();
  });

  it("never delivers another user's events to this stream", async () => {
    const user = await createUserWithPassword({
      email: "b@example.com",
      password: "correct horse battery staple",
    });
    const other = await createUserWithPassword({
      email: "c@example.com",
      password: "correct horse battery staple",
    });
    const { token } = await createDeviceSession(user.id, "Test");

    const controller = new AbortController();
    const response = await eventsRequest(token, controller.signal);
    const reader = response.body!.getReader();
    const readNext = reader.read();

    // Published for a different user -- must never resolve this stream's
    // pending read.
    publishUserEvent(other.id, {
      type: "job",
      payload: {
        jobId: 99,
        runId: null,
        kind: "article.reload",
        status: "completed",
        progress: 100,
      },
    });

    const raced = await Promise.race([
      readNext.then(() => "resolved" as const),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 100)),
    ]);
    expect(raced).toBe("timeout");

    // The same still-pending read resolves once *this* user's event fires,
    // proving the stream is live and simply never received the other user's
    // event (rather than being broken in some other way).
    publishUserEvent(user.id, {
      type: "job",
      payload: {
        jobId: 2,
        runId: null,
        kind: "article.reload",
        status: "completed",
        progress: 100,
      },
    });
    const { value } = await readNext;
    const text = new TextDecoder().decode(value);
    expect(text).toContain('"jobId":2');
    expect(text).not.toContain('"jobId":99');

    controller.abort();
    await reader.cancel();
  });

  it("unsubscribes and clears the keep-alive interval when the client disconnects", async () => {
    const setIntervalSpy = vi.spyOn(global, "setInterval");
    const clearIntervalSpy = vi.spyOn(global, "clearInterval");

    const user = await createUserWithPassword({
      email: "d@example.com",
      password: "correct horse battery staple",
    });
    const { token } = await createDeviceSession(user.id, "Test");

    const controller = new AbortController();
    const response = await eventsRequest(token, controller.signal);
    const reader = response.body!.getReader();

    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    const intervalId = setIntervalSpy.mock.results[0]!.value;

    controller.abort();
    await reader.cancel();
    // `abort` fires the listener synchronously, but give the microtask queue
    // a turn in case a future implementation defers cleanup.
    await vi.waitFor(() => {
      expect(clearIntervalSpy).toHaveBeenCalledWith(intervalId);
    });

    // The subscription itself must also be gone: publishing for this user
    // after disconnect must not throw (a listener writing to a closed
    // controller) and must not be observable on the reader, which already
    // canceled.
    expect(() =>
      publishUserEvent(user.id, {
        type: "job",
        payload: {
          jobId: 3,
          runId: null,
          kind: "article.reload",
          status: "completed",
          progress: 100,
        },
      }),
    ).not.toThrow();

    setIntervalSpy.mockRestore();
    clearIntervalSpy.mockRestore();
  });

  it("unsubscribes and clears the keep-alive interval on a bare reader.cancel(), with no request.signal abort", async () => {
    const setIntervalSpy = vi.spyOn(global, "setInterval");
    const clearIntervalSpy = vi.spyOn(global, "clearInterval");

    const user = await createUserWithPassword({
      email: "e@example.com",
      password: "correct horse battery staple",
    });
    const { token } = await createDeviceSession(user.id, "Test");

    // Deliberately no AbortController/signal here -- this is the one path
    // the other cleanup test cannot prove, because `controller.abort()`
    // there fires its listener *synchronously*, which already runs
    // `cleanup()` and closes the stream before the subsequent
    // `reader.cancel()` call ever reaches the underlying source's `cancel`
    // algorithm (a `cancel()` call on an already-`closed` stream is a no-op
    // per the Streams spec). Calling `reader.cancel()` alone, with no abort
    // anywhere in the picture, is what actually exercises the route's
    // `cancel: cleanup` hook.
    const response = await eventsRequest(token);
    const reader = response.body!.getReader();

    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    const intervalId = setIntervalSpy.mock.results[0]!.value;

    await reader.cancel();

    expect(clearIntervalSpy).toHaveBeenCalledWith(intervalId);

    // The subscription must also be gone: publishing for this user after
    // cancellation must not throw (a listener still attached would try to
    // `enqueue()` on a controller torn down by `cancel()`).
    expect(() =>
      publishUserEvent(user.id, {
        type: "job",
        payload: {
          jobId: 4,
          runId: null,
          kind: "article.reload",
          status: "completed",
          progress: 100,
        },
      }),
    ).not.toThrow();

    setIntervalSpy.mockRestore();
    clearIntervalSpy.mockRestore();
  });
});
