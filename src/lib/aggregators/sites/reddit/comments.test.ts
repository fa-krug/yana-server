import { afterEach, describe, expect, it, vi } from "vitest";
import { ArticleSkipError } from "../../errors";
import { DEFAULT_CHROME_LABELS } from "../../chrome-labels";
import { fetchPostComments, formatCommentHtml } from "./comments";
import { RedditComment } from "./types";

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

describe("formatCommentHtml", () => {
  function comment(): RedditComment {
    return new RedditComment({
      author: "Alex",
      body: "Nice post!",
      permalink: "/r/test/comments/abc123/post/def456/",
      score: 1,
    } as never);
  }

  it("renders the source link in English by default", () => {
    const html = formatCommentHtml(comment(), DEFAULT_CHROME_LABELS);
    expect(html).toContain(">source</a>");
  });

  it("renders the source link in the passed-in locale's labels", () => {
    const html = formatCommentHtml(comment(), { ...DEFAULT_CHROME_LABELS, source: "Quelle" });
    expect(html).toContain(">Quelle</a>");
    expect(html).not.toContain(">source<");
  });
});
