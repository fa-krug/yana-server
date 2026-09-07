import { afterEach, describe, expect, it, vi } from "vitest";

import { hostCooldownMs, noteRateLimited, resetHostLimits } from "./host-limiter";
import { fetchJsonThrottled, fetchTextThrottled, RATE_LIMIT_ATTEMPTS } from "./throttled-fetch";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  resetHostLimits({ minGapMs: 0, defaultCooldownMs: 0 });
});

describe("fetchTextThrottled", () => {
  it("returns the status, headers and already-read body", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response('{"ok":1}', { status: 200, headers: { "content-type": "application/json" } }),
      );

    const res = await fetchTextThrottled("https://api.example.com/a");

    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    expect(res!.ok).toBe(true);
    expect(res!.body).toBe('{"ok":1}');
    expect(res!.headers.get("content-type")).toBe("application/json");
  });

  it("retries a 429 and returns the eventual success", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("slow down", { status: 429, headers: { "retry-after": "0" } }),
      )
      .mockResolvedValueOnce(new Response("body", { status: 200 }));
    globalThis.fetch = fetchMock;

    const res = await fetchTextThrottled("https://api.example.com/a");

    expect(res!.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("records the host cooldown from Retry-After on a 429", async () => {
    resetHostLimits({ minGapMs: 0, maxCooldownMs: 60_000 });
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response("slow down", { status: 429, headers: { "retry-after": "30" } }),
      );

    await fetchTextThrottled("https://cooling.example.com/a", { attempts: 1 });

    // A sibling call to the same host waits this out -- the whole point of
    // recording it rather than just retrying locally.
    expect(hostCooldownMs("https://cooling.example.com/b")).toBeGreaterThan(25_000);
  });

  it("returns the 429 itself once attempts are exhausted, not null", async () => {
    // A fresh Response per call: a body can only be read once, so a single
    // shared instance would fail the second attempt for the wrong reason.
    const fetchMock = vi
      .fn()
      .mockImplementation(
        async () => new Response("slow down", { status: 429, headers: { "retry-after": "0" } }),
      );
    globalThis.fetch = fetchMock;

    const res = await fetchTextThrottled("https://api.example.com/a");

    // "The host refused me" and "the host never answered" are different
    // facts, and a caller (Reddit's comments) logs them differently.
    expect(res!.status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(RATE_LIMIT_ATTEMPTS);
  });

  it("honours attempts: 1 by not retrying at all", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response("slow down", { status: 429, headers: { "retry-after": "0" } }),
      );
    globalThis.fetch = fetchMock;

    await fetchTextThrottled("https://api.example.com/a", { attempts: 1 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns null when the request never produced a response", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError("fetch failed"));

    expect(await fetchTextThrottled("https://api.example.com/a")).toBeNull();
  });

  it("does not spend the request timeout waiting out the host cooldown", async () => {
    resetHostLimits({ minGapMs: 0, maxCooldownMs: 60_000 });

    // The mock has to honour the signal the way undici does. A bare
    // `vi.fn().mockResolvedValue(...)` ignores `init.signal` completely, so
    // it answers 200 even for a request that was aborted before it was sent
    // -- which would make this test pass with the defect present.
    globalThis.fetch = vi.fn().mockImplementation(async (_url, init: RequestInit) => {
      if (init.signal?.aborted) throw new DOMException("aborted", "AbortError");
      return new Response("body", { status: 200 });
    });

    // Cooldown longer than the request's own timeout. A signal built before
    // the queue wait -- `AbortSignal.timeout(...)` at the call site, which is
    // what every one of these call sites used to do -- would already be
    // aborted by the time the slot opened, turning a politely-waited request
    // into a spurious timeout. The signal has to be created inside the slot.
    noteRateLimited("https://cooling.example.com/a", 120);

    const res = await fetchTextThrottled("https://cooling.example.com/a", {
      timeoutMs: 40,
      attempts: 1,
    });

    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
  });
});

describe("fetchJsonThrottled", () => {
  it("parses a JSON body", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('{"did":"did:plc:abc"}'));

    expect(await fetchJsonThrottled<{ did: string }>("https://api.example.com/a")).toEqual({
      did: "did:plc:abc",
    });
  });

  it("returns null for a 200 whose body is not JSON", async () => {
    // Not hypothetical: Reddit's edge serves HTML block pages with a 200.
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response("<html>blocked</html>", { status: 200 }));

    expect(await fetchJsonThrottled("https://www.reddit.com/r/x/about.json")).toBeNull();
  });

  it("returns null for a non-2xx status", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("nope", { status: 500 }));

    expect(await fetchJsonThrottled("https://api.example.com/a")).toBeNull();
  });
});
