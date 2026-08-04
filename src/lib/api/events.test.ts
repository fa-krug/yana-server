import { describe, expect, it, vi } from "vitest";

import { publishUserEvent, subscribeUserEvents } from "./events";

describe("events", () => {
  it("delivers a published event only to that user's subscribers", () => {
    const heardByA = vi.fn();
    const heardByB = vi.fn();
    subscribeUserEvents("user-a", heardByA);
    subscribeUserEvents("user-b", heardByB);

    publishUserEvent("user-a", { type: "job", payload: { jobId: 1, runId: null, kind: "article.reload", status: "completed", progress: 100 } });

    expect(heardByA).toHaveBeenCalledTimes(1);
    expect(heardByB).not.toHaveBeenCalled();
  });

  it("stops delivering after unsubscribe", () => {
    const heard = vi.fn();
    const unsubscribe = subscribeUserEvents("user-c", heard);
    unsubscribe();

    publishUserEvent("user-c", { type: "run", payload: { runId: 1, status: "completed", totalJobs: 1, completedJobs: 1, failedJobs: 0 } });

    expect(heard).not.toHaveBeenCalled();
  });
});
