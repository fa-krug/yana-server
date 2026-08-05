import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { waitForRun } from "./wait-for-run";

/**
 * A `.tsx` test for a module with no JSX in it, deliberately -- same reason
 * `src/lib/attempt.test.tsx` is one: the file extension picks the vitest
 * project (see CLAUDE.md), and this is browser code (`EventSource`), which
 * jsdom does not implement natively. `MockEventSource` below stands in for
 * it, the same way other tests here stub `next/navigation` or `next/headers`
 * rather than the thing under test.
 */
class MockEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;

  url: string;
  readyState = MockEventSource.CONNECTING;
  onerror: (() => void) | null = null;
  closed = false;
  private listeners = new Map<string, Set<(event: { data: string }) => void>>();

  constructor(url: string) {
    this.url = url;
    this.readyState = MockEventSource.OPEN;
    instances.push(this);
  }

  addEventListener(type: string, listener: (event: { data: string }) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }

  close(): void {
    this.closed = true;
    this.readyState = MockEventSource.CLOSED;
  }

  emit(type: string, data: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data: JSON.stringify(data) });
    }
  }

  fail(): void {
    this.readyState = MockEventSource.CLOSED;
    this.onerror?.();
  }

  retry(): void {
    this.readyState = MockEventSource.CONNECTING;
    this.onerror?.();
    this.readyState = MockEventSource.OPEN;
  }
}

let instances: MockEventSource[] = [];

beforeEach(() => {
  instances = [];
  vi.stubGlobal("EventSource", MockEventSource);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("waitForRun", () => {
  it("resolves once the stream reports a completed run", async () => {
    const promise = waitForRun(1);
    const source = instances[0]!;
    expect(source.url).toBe("/api/runs/1/status-stream");

    source.emit("status", { status: "completed", totalJobs: 3, completedJobs: 3, failedJobs: 0 });

    await expect(promise).resolves.toEqual({
      ok: true,
      status: { status: "completed", totalJobs: 3, completedJobs: 3, failedJobs: 0 },
    });
    expect(source.closed).toBe(true);
  });

  it("resolves once the stream reports a failed run", async () => {
    const promise = waitForRun(2);
    const source = instances[0]!;

    source.emit("status", { status: "failed", totalJobs: 2, completedJobs: 1, failedJobs: 1 });

    await expect(promise).resolves.toEqual({
      ok: true,
      status: { status: "failed", totalJobs: 2, completedJobs: 1, failedJobs: 1 },
    });
  });

  it("keeps waiting through a non-terminal status update", async () => {
    const promise = waitForRun(3);
    const source = instances[0]!;

    source.emit("status", { status: "running", totalJobs: 2, completedJobs: 1, failedJobs: 0 });
    source.emit("status", { status: "completed", totalJobs: 2, completedJobs: 2, failedJobs: 0 });

    await expect(promise).resolves.toEqual({
      ok: true,
      status: { status: "completed", totalJobs: 2, completedJobs: 2, failedJobs: 0 },
    });
  });

  it("keeps waiting through a transient reconnect instead of resolving", async () => {
    const promise = waitForRun(4);
    const source = instances[0]!;

    // A drop `EventSource` itself retries from (readyState cycles back to
    // OPEN) must not resolve the wait -- only a permanent CLOSED does.
    source.retry();
    source.emit("status", { status: "completed", totalJobs: 1, completedJobs: 1, failedJobs: 0 });

    await expect(promise).resolves.toEqual({
      ok: true,
      status: { status: "completed", totalJobs: 1, completedJobs: 1, failedJobs: 0 },
    });
  });

  it("resolves request-failed when the connection closes permanently (e.g. a 404)", async () => {
    const promise = waitForRun(5);
    const source = instances[0]!;

    source.fail();

    await expect(promise).resolves.toEqual({ ok: false, reason: "request-failed" });
  });
});
