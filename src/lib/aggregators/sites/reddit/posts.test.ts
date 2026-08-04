import { afterEach, describe, expect, it, vi } from "vitest";
import { AggregatorError } from "../../errors";
import { fetchRedditPost } from "./posts";

describe("fetchRedditPost", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("throws AggregatorError on a 401 instead of returning null", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 401 })));

    await expect(fetchRedditPost("test", "abc123")).rejects.toThrow(AggregatorError);
  });

  it("returns null on a 404 (post genuinely gone)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 404 })));

    const post = await fetchRedditPost("test", "abc123");
    expect(post).toBeNull();
  });

  it("returns null on a transport failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

    const post = await fetchRedditPost("test", "abc123");
    expect(post).toBeNull();
  });
});
