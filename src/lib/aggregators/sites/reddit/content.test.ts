import { describe, expect, it } from "vitest";
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
