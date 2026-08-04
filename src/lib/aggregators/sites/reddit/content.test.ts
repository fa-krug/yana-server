import { afterEach, describe, expect, it, vi } from "vitest";
import { ArticleSkipError } from "../../errors";
import { RedditPostData } from "./types";
import { buildPostContent } from "./content";

describe("buildPostContent Giphy link handling", () => {
  it("renders a Giphy watch-page link post as an inline GIF, not a dead link", async () => {
    const post = new RedditPostData({
      id: "abc123",
      permalink: "/r/test/comments/abc123/title/",
      url: "https://giphy.com/gifs/some-slug-AbC123xyz",
      is_self: false,
    });

    const html = await buildPostContent(post, 0, "test");

    expect(html).toContain('<img src="https://media.giphy.com/media/AbC123xyz/giphy.gif"');
    expect(html).not.toContain("giphy.com/gifs");
  });
});

describe("buildPostContent comment-fetch failures", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const post = () =>
    new RedditPostData({
      id: "abc123",
      permalink: "/r/test/comments/abc123/title/",
      is_self: true,
      selftext: "body",
    });

  it("propagates an ArticleSkipError from the comments fetch instead of degrading", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 403 })));

    await expect(buildPostContent(post(), 10, "test")).rejects.toThrow(ArticleSkipError);
  });

  it("does not skip the article for an ordinary transport failure", async () => {
    // `fetchPostComments()` absorbs a network failure itself and answers `[]`,
    // so only the skip error reaches this caller -- the re-throw above is
    // narrow, not a blanket "let comment failures fail the article".
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("socket hang up")));

    const html = await buildPostContent(post(), 10, "test");
    expect(html).toContain("No comments yet.");
  });
});
