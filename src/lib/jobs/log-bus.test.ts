import { describe, expect, it, vi } from "vitest";

import { publishJobLog, subscribeJobLog } from "./log-bus";
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
});
