import { afterEach, describe, expect, it, vi } from "vitest";
import { ArticleSkipError } from "../../errors";
import { fetchPostComments } from "./comments";

describe("fetchPostComments", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("throws ArticleSkipError when the post is private or removed (403)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 403 })));

    await expect(fetchPostComments("test", "abc123", 10)).rejects.toThrow(ArticleSkipError);
  });

  it("throws ArticleSkipError when the post is not found (404)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 404 })));

    await expect(fetchPostComments("test", "abc123", 10)).rejects.toThrow(ArticleSkipError);
  });

  it("degrades to an empty list on a transport failure, without throwing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

    const comments = await fetchPostComments("test", "abc123", 10);
    expect(comments).toEqual([]);
  });

  it("degrades to an empty list on a 500, without throwing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 500 })));

    const comments = await fetchPostComments("test", "abc123", 10);
    expect(comments).toEqual([]);
  });
});
