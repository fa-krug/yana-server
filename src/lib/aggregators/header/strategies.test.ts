import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_JSON_BYTES } from "../http/fetcher";
import { countingStream, settledAfterFakeTime, stallingBodyResponse } from "../http/test-support";
import { fetchSubredditIcon } from "./strategies";

describe("fetchSubredditIcon bounds", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("passes an abort signal, so the call has a deadline at all", async () => {
    // This fetch carried no `signal` whatsoever before 2026-09-04.
    const inits: RequestInit[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(((_url: string, init: RequestInit) => {
      inits.push(init);
      return Promise.resolve(
        new Response(JSON.stringify({ data: { icon_img: "https://i/1.png" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }) as unknown as typeof fetch);

    expect(await fetchSubredditIcon("all")).toBe("https://i/1.png");
    expect(inits[0].signal).toBeInstanceOf(AbortSignal);
  });

  it("settles when a server sends headers and then stalls", async () => {
    // With no signal, nothing could interrupt this drain -- the worker loop
    // running it was held open indefinitely. See withDeadline().
    vi.spyOn(globalThis, "fetch").mockImplementation(((_url: string, init: RequestInit) =>
      Promise.resolve(
        stallingBodyResponse(init.signal, {
          "content-type": "application/json",
        }),
      )) as unknown as typeof fetch);
    vi.useFakeTimers();

    expect(
      await settledAfterFakeTime(fetchSubredditIcon("all"), 10_000, (ms) =>
        vi.advanceTimersByTimeAsync(ms),
      ),
    ).toBe("settled");
  });

  it("stops reading at the byte cap instead of buffering the whole body", async () => {
    const { stream, state } = countingStream(20);
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(stream, { status: 200, headers: { "content-type": "application/json" } }),
    );

    expect(await fetchSubredditIcon("all")).toBeNull();
    expect(state.cancelled).toBe(true);
    expect(state.pulls).toBeLessThanOrEqual(MAX_JSON_BYTES / (1024 * 1024) + 2);
  });
});
