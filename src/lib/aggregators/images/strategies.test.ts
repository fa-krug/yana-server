import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_JSON_BYTES } from "../http/fetcher";
import { countingStream, settledAfterFakeTime, stallingBodyResponse } from "../http/test-support";
import { extractTweetId, fetchTweetData } from "./strategies";

describe("extractTweetId", () => {
  it("reads the digits out of a status path and refuses anything else", () => {
    expect(extractTweetId("https://x.com/a/status/1234567890")).toBe("1234567890");
    expect(extractTweetId("https://x.com/a/status/abc")).toBeNull();
    expect(extractTweetId("")).toBeNull();
  });
});

describe("fetchTweetData bounds", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("keeps a deadline over the body, not only the headers", async () => {
    // The timer was cleared on the line above `res.json()`, so a host that
    // sent headers and then stalled held this call, and its worker loop, open
    // forever -- worker.ts's budget timer only requests cooperative
    // cancellation and has no checkpoint inside a fetch.
    vi.spyOn(globalThis, "fetch").mockImplementation(((_url: string, init: RequestInit) =>
      Promise.resolve(
        stallingBodyResponse(init.signal, {
          "content-type": "application/json",
        }),
      )) as unknown as typeof fetch);
    vi.useFakeTimers();

    expect(
      await settledAfterFakeTime(fetchTweetData("1234567890", 5_000), 5_000, (ms) =>
        vi.advanceTimersByTimeAsync(ms),
      ),
    ).toBe("settled");
  });

  it("stops reading at the byte cap instead of buffering the whole body", async () => {
    // `res.json()` buffers whatever arrives, with no ceiling.
    const { stream, state } = countingStream(20);
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(stream, { status: 200, headers: { "content-type": "application/json" } }),
    );

    expect(await fetchTweetData("1234567890")).toBeNull();
    expect(state.cancelled).toBe(true);
    expect(state.pulls).toBeLessThanOrEqual(MAX_JSON_BYTES / (1024 * 1024) + 2);
  });

  it("still returns the parsed body on a normal answer", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ tweet: { media: { photos: [{ url: "u" }] } } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    expect(await fetchTweetData("1234567890")).toMatchObject({ tweet: { media: {} } });
  });
});
