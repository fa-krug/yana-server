import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_HOST_LIMITS,
  hostCooldownMs,
  noteRateLimited,
  parseRetryAfterMs,
  resetHostLimits,
  withHostLimit,
} from "./host-limiter";

/**
 * These cases set their own limits rather than inheriting the node project's
 * setup file (`src/test/setup-node.ts`, which zeroes `minGapMs`) -- the gap is
 * half of what this module does, so a test that ran with it at 0 would be
 * asserting against a limiter with the feature switched off.
 */
afterEach(() => {
  resetHostLimits({ minGapMs: 0, defaultCooldownMs: 0 });
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("host-limiter defaults", () => {
  it("caps concurrency and spaces requests by default", () => {
    expect(DEFAULT_HOST_LIMITS.maxConcurrent).toBe(2);
    expect(DEFAULT_HOST_LIMITS.minGapMs).toBe(500);
    expect(DEFAULT_HOST_LIMITS.maxCooldownMs).toBe(60_000);
  });
});

describe("withHostLimit", () => {
  it("never runs more than maxConcurrent requests against one host", async () => {
    resetHostLimits({ maxConcurrent: 2, minGapMs: 0 });

    let inFlight = 0;
    let maxInFlight = 0;
    const gate = deferred();

    const runs = Array.from({ length: 6 }, () =>
      withHostLimit("https://www.heise.de/a", async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await gate.promise;
        inFlight--;
      }),
    );

    // Let every call queue up before any of them is allowed to finish, so the
    // cap is what bounds the count rather than the tasks completing serially.
    await Promise.resolve();
    gate.resolve();
    await Promise.all(runs);

    expect(maxInFlight).toBe(2);
  });

  it("counts hosts separately, so one slow site does not throttle another", async () => {
    resetHostLimits({ maxConcurrent: 1, minGapMs: 0 });

    let inFlight = 0;
    let maxInFlight = 0;
    const gate = deferred();

    const runs = ["https://www.heise.de/a", "https://example.com/b"].map((url) =>
      withHostLimit(url, async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await gate.promise;
        inFlight--;
      }),
    );

    await Promise.resolve();
    gate.resolve();
    await Promise.all(runs);

    // One each, concurrently -- a shared cap would have serialized them to 1.
    expect(maxInFlight).toBe(2);
  });

  it("spaces successive requests to one host by minGapMs", async () => {
    resetHostLimits({ maxConcurrent: 4, minGapMs: 60 });

    const starts: number[] = [];
    await Promise.all(
      Array.from({ length: 3 }, () =>
        withHostLimit("https://www.heise.de/a", async () => {
          starts.push(Date.now());
        }),
      ),
    );

    expect(starts).toHaveLength(3);
    // Two gaps of at least 60ms each. Compared against the span rather than
    // each pair so a slow CI runner cannot make it flaky in the other
    // direction.
    expect(starts[2] - starts[0]).toBeGreaterThanOrEqual(110);
  });

  it("releases the slot when the wrapped call throws", async () => {
    resetHostLimits({ maxConcurrent: 1, minGapMs: 0 });

    await expect(
      withHostLimit("https://www.heise.de/a", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    // A leaked slot would leave this one queued forever, so the assertion is
    // that it resolves at all.
    await expect(withHostLimit("https://www.heise.de/a", async () => "second")).resolves.toBe(
      "second",
    );
  });

  it("runs a URL with no parseable hostname unthrottled rather than refusing it", async () => {
    resetHostLimits({ maxConcurrent: 1, minGapMs: 10_000 });

    await expect(withHostLimit("not a url", async () => "ran")).resolves.toBe("ran");
    await expect(withHostLimit("not a url", async () => "ran again")).resolves.toBe("ran again");
  });

  it("holds every request to a host until its cooldown expires", async () => {
    resetHostLimits({ maxConcurrent: 4, minGapMs: 0 });

    noteRateLimited("https://www.heise.de/a", 60);

    const before = Date.now();
    // A *different* URL on the same host: a 429 is a statement about the host,
    // not about the one request that drew it.
    await withHostLimit("https://www.heise.de/b", async () => {});

    expect(Date.now() - before).toBeGreaterThanOrEqual(50);
  });
});

describe("noteRateLimited", () => {
  it("uses the host's Retry-After, clamped to maxCooldownMs", () => {
    resetHostLimits({ maxCooldownMs: 1_000 });

    noteRateLimited("https://www.heise.de/a", 30_000);

    expect(hostCooldownMs("https://www.heise.de/a")).toBeGreaterThan(0);
    expect(hostCooldownMs("https://www.heise.de/a")).toBeLessThanOrEqual(1_000);
  });

  it("falls back to defaultCooldownMs when the host named no delay", () => {
    resetHostLimits({ defaultCooldownMs: 5_000 });

    noteRateLimited("https://www.heise.de/a", null);

    expect(hostCooldownMs("https://www.heise.de/a")).toBeGreaterThan(4_000);
  });

  it("extends an existing cooldown but never shortens one", () => {
    resetHostLimits({ maxCooldownMs: 60_000 });

    noteRateLimited("https://www.heise.de/a", 30_000);
    const long = hostCooldownMs("https://www.heise.de/a");

    // A second 429 arriving mid-cooldown asking for less must not buy the
    // host a shorter wait than the first one already earned.
    noteRateLimited("https://www.heise.de/a", 1_000);

    expect(hostCooldownMs("https://www.heise.de/a")).toBeGreaterThan(long - 1_000);
  });

  it("holds only the host that answered 429", () => {
    resetHostLimits({ defaultCooldownMs: 5_000 });

    noteRateLimited("https://www.heise.de/a", null);

    expect(hostCooldownMs("https://www.heise.de/a")).toBeGreaterThan(0);
    expect(hostCooldownMs("https://example.com/a")).toBe(0);
  });
});

describe("parseRetryAfterMs", () => {
  it("reads delta-seconds", () => {
    expect(parseRetryAfterMs("30")).toBe(30_000);
    expect(parseRetryAfterMs("  0  ")).toBe(0);
  });

  it("reads an HTTP-date as a delay from now", () => {
    const future = new Date(Date.now() + 20_000).toUTCString();
    const parsed = parseRetryAfterMs(future);

    expect(parsed).not.toBeNull();
    expect(parsed!).toBeGreaterThan(10_000);
    expect(parsed!).toBeLessThanOrEqual(20_000);
  });

  it("returns null for a missing, unparseable or already-past value", () => {
    expect(parseRetryAfterMs(null)).toBeNull();
    expect(parseRetryAfterMs("")).toBeNull();
    expect(parseRetryAfterMs("soon")).toBeNull();
    expect(parseRetryAfterMs(new Date(Date.now() - 20_000).toUTCString())).toBeNull();
  });
});
