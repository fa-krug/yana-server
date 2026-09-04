import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_JSON_BYTES } from "../../http/fetcher";
import {
  countingStream,
  settledAfterFakeTime,
  stallingBodyResponse,
} from "../../http/test-support";
import { YouTubeAPIError, YouTubeClient } from "./client";

describe("YouTubeClient._get bounds", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("passes an abort signal, so the call has a deadline at all", async () => {
    // This fetch carried no `signal` whatsoever before 2026-09-04 -- the one
    // fetch in the aggregator tree with no deadline of any kind.
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

    await expect(new YouTubeClient("k")._get("channels", { id: "c" })).rejects.toBeInstanceOf(
      YouTubeAPIError,
    );
    expect(state.cancelled).toBe(true);
    expect(state.pulls).toBeLessThanOrEqual(MAX_JSON_BYTES / (1024 * 1024) + 2);
  });
});
