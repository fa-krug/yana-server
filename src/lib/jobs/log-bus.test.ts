import { describe, expect, it, vi } from "vitest";

import {
  publishJobLog,
  publishJobTerminal,
  subscribeJobLog,
  subscribeJobTerminal,
} from "./log-bus";
import type { JobLog } from "../db/schema";

function line(overrides: Partial<JobLog> = {}): JobLog {
  return {
    id: 1,
    jobId: 1,
    stream: "stdout",
    line: "hello",
    createdAt: new Date(),
    ...overrides,
  };
}

describe("src/lib/jobs/log-bus", () => {
  it("delivers a published line only to subscribers of that job id", () => {
    const forJob1 = vi.fn();
    const forJob2 = vi.fn();
    subscribeJobLog(1, forJob1);
    subscribeJobLog(2, forJob2);

    publishJobLog(1, line({ jobId: 1 }));

    expect(forJob1).toHaveBeenCalledTimes(1);
    expect(forJob2).not.toHaveBeenCalled();
  });

  it("stops delivering after unsubscribe", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeJobLog(3, listener);

    unsubscribe();
    publishJobLog(3, line({ jobId: 3 }));

    expect(listener).not.toHaveBeenCalled();
  });

  it("never throws when publishing with no subscribers", () => {
    expect(() => publishJobLog(999, line({ jobId: 999 }))).not.toThrow();
  });

  /**
   * See the identical test in `src/lib/api/events.test.ts` for why this
   * matters: Next puts the instrumentation-started worker (the publisher)
   * and route handlers (the subscribers) in separate webpack chunks, each
   * re-evaluating this module rather than sharing one loaded copy.
   * `vi.resetModules()` plus a fresh `import()` stands in for that. Before
   * the `globalThis`/`Symbol.for()` fix, each instance had its own
   * `EventEmitter` and a publish through one was invisible to a subscriber
   * registered through the other.
   */
  it("delivers a published line across separate module instantiations", async () => {
    const first = await import("./log-bus");
    const heard = vi.fn();
    first.subscribeJobLog(5, heard);

    vi.resetModules();
    const second = await import("./log-bus");
    second.publishJobLog(5, line({ jobId: 5 }));

    expect(heard).toHaveBeenCalledTimes(1);
  });

  describe("job terminal channel", () => {
    it("delivers a published terminal status only to subscribers of that job id", () => {
      const forJob1 = vi.fn();
      const forJob2 = vi.fn();
      subscribeJobTerminal(1, forJob1);
      subscribeJobTerminal(2, forJob2);

      publishJobTerminal(1, "completed");

      expect(forJob1).toHaveBeenCalledTimes(1);
      expect(forJob1).toHaveBeenCalledWith("completed");
      expect(forJob2).not.toHaveBeenCalled();
    });

    it("stops delivering after unsubscribe", () => {
      const listener = vi.fn();
      const unsubscribe = subscribeJobTerminal(3, listener);

      unsubscribe();
      publishJobTerminal(3, "failed");

      expect(listener).not.toHaveBeenCalled();
    });

    it("never throws when publishing with no subscribers", () => {
      expect(() => publishJobTerminal(999, "completed")).not.toThrow();
    });

    it("uses a channel namespace distinct from the line-log channel, so a job id never collides", () => {
      const logListener = vi.fn();
      const terminalListener = vi.fn();
      subscribeJobLog(4, logListener);
      subscribeJobTerminal(4, terminalListener);

      publishJobTerminal(4, "completed");
      expect(logListener).not.toHaveBeenCalled();

      publishJobLog(4, line({ jobId: 4 }));
      expect(terminalListener).toHaveBeenCalledTimes(1);
    });
  });
});
