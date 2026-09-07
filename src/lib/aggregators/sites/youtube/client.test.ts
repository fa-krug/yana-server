/**
 * Both halves of what `_get()` had to survive, in one file.
 *
 * The bounds cases (deadline, byte cap) came from the branch that gave every
 * aggregator fetch a `withDeadline()` and a capped read; the quota and no-echo
 * cases came from the branch that put this client onto
 * `fetchTextThrottled()`. Neither set replaced the other: routing through the
 * shared loop is what *keeps* the bounds, so they are still worth asserting
 * from out here -- a future `_get()` that goes back to a bare `fetch` would
 * pass every quota case and fail these.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { MAX_JSON_BYTES } from "@/lib/aggregators/http/fetcher";
import { resetHostLimits } from "@/lib/aggregators/http/host-limiter";
import {
  countingStream,
  settledAfterFakeTime,
  stallingBodyResponse,
} from "@/lib/aggregators/http/test-support";
import { RATE_LIMIT_ATTEMPTS } from "@/lib/aggregators/http/throttled-fetch";

import { YouTubeAPIError, YouTubeClient, YouTubeQuotaError } from "./client";

const originalFetch = globalThis.fetch;
const KEY = "super-secret-api-key";

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetHostLimits({ minGapMs: 0, defaultCooldownMs: 0 });
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function quotaBody(): unknown {
  return { error: { errors: [{ reason: "quotaExceeded" }], status: "RESOURCE_EXHAUSTED" } };
}

describe("YouTubeClient._get", () => {
  it("returns the parsed body", async () => {
    globalThis.fetch = vi.fn().mockImplementation(async () => json({ items: [{ id: "UC1" }] }));

    const data = await new YouTubeClient(KEY)._get<{ items: { id: string }[] }>("channels", {
      part: "id",
      id: "UC1",
    });

    expect(data.items[0].id).toBe("UC1");
  });

  it("sends every request with a timeout signal", async () => {
    // Not a caller-built signal: `fetchTextThrottled()` builds one inside the
    // throttle slot, so a queued request does not spend its own budget waiting.
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      expect(init.signal).toBeInstanceOf(AbortSignal);
      expect(init.signal?.aborted).toBe(false);
      return json({ items: [] });
    });
    globalThis.fetch = fetchMock;

    await new YouTubeClient(KEY)._get("channels", { part: "id" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("passes an abort signal, so the call has a deadline at all", async () => {
    // This fetch carried no `signal` whatsoever before 2026-09-04 -- the one
    // fetch in the aggregator tree with no deadline of any kind. It reaches the
    // signal by a different route now (the shared throttled loop rather than a
    // `withDeadline()` written here), which is exactly why the assertion is
    // still on the `init` the mock was handed rather than on the call shape.
    const inits: RequestInit[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(((_url: string, init: RequestInit) => {
      inits.push(init);
      return Promise.resolve(
        new Response(JSON.stringify({ items: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }) as unknown as typeof fetch);

    expect(await new YouTubeClient("k")._get("channels", { id: "c" })).toMatchObject({ items: [] });
    expect(inits[0].signal).toBeInstanceOf(AbortSignal);
  });

  it("settles when a server sends headers and then stalls", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(((_url: string, init: RequestInit) =>
      Promise.resolve(
        stallingBodyResponse(init.signal, {
          "content-type": "application/json",
        }),
      )) as unknown as typeof fetch);
    vi.useFakeTimers();

    expect(
      await settledAfterFakeTime(
        new YouTubeClient("k")._get("channels", { id: "c" }).catch(() => null),
        30_000,
        (ms) => vi.advanceTimersByTimeAsync(ms),
      ),
    ).toBe("settled");
  });

  it("stops reading at the byte cap instead of buffering the whole body", async () => {
    const { stream, state } = countingStream(20);
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(stream, { status: 200, headers: { "content-type": "application/json" } }),
    );

    // Still a `YouTubeAPIError`, but by a deliberately different route than it
    // was: `fetchTextThrottled()` catches the `ResponseTooLarge` itself and
    // reports `null`, the same answer it gives for a network failure, because
    // no caller in the tree can act on the difference. So the message is the
    // generic "no response" one rather than a cap-specific error -- what this
    // case is here to pin is that the read stopped, not how it was named.
    await expect(new YouTubeClient("k")._get("channels", { id: "c" })).rejects.toBeInstanceOf(
      YouTubeAPIError,
    );
    expect(state.cancelled).toBe(true);
    expect(state.pulls).toBeLessThanOrEqual(MAX_JSON_BYTES / (1024 * 1024) + 2);
  });

  it("throws a quota error on a 403 carrying quotaExceeded", async () => {
    globalThis.fetch = vi.fn().mockImplementation(async () => json(quotaBody(), 403));

    await expect(new YouTubeClient(KEY)._get("channels", { part: "id" })).rejects.toBeInstanceOf(
      YouTubeQuotaError,
    );
  });

  it("throws a quota error on a 403 carrying only the newer RESOURCE_EXHAUSTED status", async () => {
    globalThis.fetch = vi
      .fn()
      .mockImplementation(async () => json({ error: { status: "RESOURCE_EXHAUSTED" } }, 403));

    await expect(new YouTubeClient(KEY)._get("videos", { part: "id" })).rejects.toBeInstanceOf(
      YouTubeQuotaError,
    );
  });

  it("throws a plain API error, not a quota error, on a rejected key", async () => {
    globalThis.fetch = vi
      .fn()
      .mockImplementation(async () => json({ error: { errors: [{ reason: "keyInvalid" }] } }, 400));

    const error = await new YouTubeClient(KEY)
      ._get("channels", { part: "id" })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(YouTubeAPIError);
    expect(error).not.toBeInstanceOf(YouTubeQuotaError);
  });

  it("never puts the API key or the response body in the error message", async () => {
    globalThis.fetch = vi
      .fn()
      .mockImplementation(async () => json({ error: { message: `bad key ${KEY}` } }, 400));

    const error = (await new YouTubeClient(KEY)
      ._get("channels", { part: "id" })
      .catch((e: unknown) => e)) as Error;

    expect(error.message).not.toContain(KEY);
    expect(error.message).toContain("400");
  });

  it("retries a 429 and then throws", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(
        async () => new Response("slow down", { status: 429, headers: { "retry-after": "0" } }),
      );
    globalThis.fetch = fetchMock;

    await expect(new YouTubeClient(KEY)._get("search", { part: "id" })).rejects.toBeInstanceOf(
      YouTubeAPIError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(RATE_LIMIT_ATTEMPTS);
  });

  it("throws rather than resolving when the host never answers", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("ENOTFOUND"));

    await expect(new YouTubeClient(KEY)._get("channels", { part: "id" })).rejects.toBeInstanceOf(
      YouTubeAPIError,
    );
  });
});

describe("quota exhaustion is not reported as missing data", () => {
  it("propagates out of resolveChannelId instead of answering 'not found'", async () => {
    globalThis.fetch = vi.fn().mockImplementation(async () => json(quotaBody(), 403));

    await expect(
      new YouTubeClient(KEY).resolveChannelId("UCabcdefghijklmnopqrstuv"),
    ).rejects.toBeInstanceOf(YouTubeQuotaError);
  });

  it("propagates out of a handle resolve instead of answering 'not found'", async () => {
    globalThis.fetch = vi.fn().mockImplementation(async () => json(quotaBody(), 403));

    await expect(new YouTubeClient(KEY).resolveChannelId("@youtube")).rejects.toBeInstanceOf(
      YouTubeQuotaError,
    );
  });

  it("logs rather than throwing when comments are the casualty", async () => {
    // Same ruling as Reddit's comment path: a run that has already fetched its
    // videos is worth shipping without comments, but not silently.
    globalThis.fetch = vi.fn().mockImplementation(async () => json(quotaBody(), 403));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(new YouTubeClient(KEY).fetchVideoComments("vid", 5)).resolves.toEqual([]);
    expect(warn).toHaveBeenCalled();
  });
});
