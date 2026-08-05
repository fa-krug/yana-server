import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { waitForJobsTerminal } from "./wait-for-jobs-terminal";

/**
 * A `.tsx` test for a module with no JSX in it, deliberately -- same reason
 * `src/lib/jobs/wait-for-run.test.tsx` is one: the file extension picks the
 * vitest project (see CLAUDE.md), and this is browser code (`EventSource`),
 * which jsdom does not implement natively.
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
}

let instances: MockEventSource[] = [];

beforeEach(() => {
  instances = [];
  vi.stubGlobal("EventSource", MockEventSource);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("waitForJobsTerminal", () => {
  it("resolves true immediately for an empty list, opening no connection", async () => {
    await expect(waitForJobsTerminal([])).resolves.toBe(true);
    expect(instances).toHaveLength(0);
  });

  it("resolves true once every id has reported done", async () => {
    const promise = waitForJobsTerminal([1, 2]);
    const source = instances[0]!;
    expect(source.url).toBe("/api/jobs/status-stream?ids=1,2");

    source.emit("done", { id: 1, status: "completed" });
    source.emit("done", { id: 2, status: "cancelled" });

    await expect(promise).resolves.toBe(true);
    expect(source.closed).toBe(true);
  });

  it("keeps waiting until every id has reported, not just the first", async () => {
    const promise = waitForJobsTerminal([1, 2]);
    const source = instances[0]!;

    source.emit("done", { id: 1, status: "completed" });
    expect(source.closed).toBe(false);

    source.emit("done", { id: 2, status: "failed" });
    await expect(promise).resolves.toBe(true);
  });

  it("resolves false when the connection closes permanently before every id reports in", async () => {
    const promise = waitForJobsTerminal([1, 2]);
    const source = instances[0]!;

    source.emit("done", { id: 1, status: "completed" });
    source.fail();

    await expect(promise).resolves.toBe(false);
  });
});
