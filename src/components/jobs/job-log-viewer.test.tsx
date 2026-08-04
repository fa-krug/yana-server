import { act, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/render";

import { JobLogViewer } from "./job-log-viewer";

/**
 * jsdom does not implement `EventSource` -- there is no existing precedent in
 * this repo for testing one, so this is a minimal stand-in: it records every
 * instance created (so a test can reach the one the component opened) and
 * lets a test fire a named event with a JSON-encoded payload, matching the
 * real `EventSource`'s `addEventListener(type, listener)` shape closely
 * enough for `JobLogViewer` to be unable to tell the difference.
 */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  closed = false;
  private listeners = new Map<string, ((event: MessageEvent) => void)[]>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string, data: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data: JSON.stringify(data) } as MessageEvent);
    }
  }
}

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const INITIAL = [
  {
    id: 1,
    stream: "stdout" as const,
    line: "job started (attempt 1/1)",
    createdAt: "2026-08-04T00:00:00.000Z",
  },
  { id: 2, stream: "stderr" as const, line: "oh no", createdAt: "2026-08-04T00:00:01.000Z" },
];

describe("JobLogViewer", () => {
  it("renders the initial lines", () => {
    renderWithProviders(<JobLogViewer jobId={7} initialLines={INITIAL} />);

    expect(screen.getByText("job started (attempt 1/1)")).toBeTruthy();
    expect(screen.getByText("oh no")).toBeTruthy();
  });

  it("shows the empty state with no lines", () => {
    renderWithProviders(<JobLogViewer jobId={7} initialLines={[]} />);

    expect(screen.getByText("No log output yet.")).toBeTruthy();
  });

  it("opens an EventSource at the job's log-stream URL, cursored after the last initial line", () => {
    renderWithProviders(<JobLogViewer jobId={7} initialLines={INITIAL} />);

    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0]!.url).toBe("/api/jobs/7/log-stream?after=2");
  });

  it("appends a line received over the live stream", () => {
    renderWithProviders(<JobLogViewer jobId={7} initialLines={INITIAL} />);
    const source = FakeEventSource.instances[0]!;

    act(() => {
      source.emit("line", {
        id: 3,
        stream: "stdout",
        line: "a new line",
        createdAt: "2026-08-04T00:00:02.000Z",
      });
    });

    expect(screen.getByText("a new line")).toBeTruthy();
  });

  it("shows the ended state and closes the source on an end event", () => {
    renderWithProviders(<JobLogViewer jobId={7} initialLines={INITIAL} />);
    const source = FakeEventSource.instances[0]!;

    act(() => {
      source.emit("end", { status: "completed" });
    });

    expect(screen.getByText("Job finished — log ended.")).toBeTruthy();
    expect(source.closed).toBe(true);
  });
});
