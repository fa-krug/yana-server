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

  it("retries a 429 rather than losing the comments on the first refusal", async () => {
    const listing = JSON.stringify([
      {},
      {
        data: {
          children: [
            {
              kind: "t1",
              data: {
                author: "Alex",
                body: "Nice post!",
                permalink: "/r/test/comments/abc123/post/def456/",
                score: 7,
              },
            },
          ],
        },
      },
    ]);

    // A fresh Response per call -- a body can only be read once.
    let call = 0;
    const fetchMock = vi.fn().mockImplementation(async () => {
      call += 1;
      return call === 1
        ? new Response("slow down", { status: 429, headers: { "retry-after": "0" } })
        : new Response(listing, { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const comments = await fetchPostComments("test", "abc123", 10);

    // Reddit's limits are far tighter than a website's and this runs once
    // per article, so folding a 429 into the same silent `[]` as a 500
    // shipped articles with an empty comment section that looked exactly
    // like a post nobody had replied to.
    expect(comments).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("logs, rather than silently swallowing, a 429 that survives every attempt", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockImplementation(
          async () => new Response("slow down", { status: 429, headers: { "retry-after": "0" } }),
        ),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const comments = await fetchPostComments("test", "abc123", 10);

    expect(comments).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("rate limited"));
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
