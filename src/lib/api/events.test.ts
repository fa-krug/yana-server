import { describe, expect, it, vi } from "vitest";

import { publishUserEvent, subscribeUserEvents } from "./events";

describe("events", () => {
  it("delivers a published event only to that user's subscribers", () => {
    const heardByA = vi.fn();
    const heardByB = vi.fn();
    subscribeUserEvents("user-a", heardByA);
    subscribeUserEvents("user-b", heardByB);

    publishUserEvent("user-a", {
      type: "job",
      payload: {
        jobId: 1,
        runId: null,
        kind: "article.reload",
        status: "completed",
        progress: 100,
      },
    });

    expect(heardByA).toHaveBeenCalledTimes(1);
    expect(heardByB).not.toHaveBeenCalled();
  });

  it("stops delivering after unsubscribe", () => {
    const heard = vi.fn();
    const unsubscribe = subscribeUserEvents("user-c", heard);
    unsubscribe();

    publishUserEvent("user-c", {
      type: "run",
      payload: { runId: 1, status: "completed", totalJobs: 1, completedJobs: 1, failedJobs: 0 },
    });

    expect(heard).not.toHaveBeenCalled();
  });

  /**
   * Next bundles the instrumentation hook that starts the worker (the
   * publisher) and each route handler (a subscriber) into separate webpack
   * chunks, so this module gets re-evaluated once per chunk that imports it
   * rather than loaded once and shared. `vi.resetModules()` plus a fresh
   * `import()` is the same stand-in this repo's other module-identity tests
   * use for that -- two independent module instances, exactly like two
   * separate chunks would produce. Before the `globalThis`/`Symbol.for()`
   * fix, each instance had its own `EventEmitter`, so a subscriber
   * registered through one instance never heard a publish made through the
   * other -- which is exactly how a run's "completed" event never reached
   * `/api/runs/[id]/status-stream`'s subscriber and left the header's
   * run-tracking spinner spinning forever.
   */
  it("delivers a published event across separate module instantiations", async () => {
    const first = await import("./events");
    const heard = vi.fn();
    first.subscribeUserEvents("user-d", heard);

    vi.resetModules();
    const second = await import("./events");
    second.publishUserEvent("user-d", {
      type: "run",
      payload: { runId: 1, status: "completed", totalJobs: 1, completedJobs: 1, failedJobs: 0 },
    });

    expect(heard).toHaveBeenCalledTimes(1);
  });
});
