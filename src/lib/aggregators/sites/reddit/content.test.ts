import { afterEach, describe, expect, it, vi } from "vitest";
import { ArticleSkipError } from "../../errors";
import { RedditPostData } from "./types";
import { buildPostContent } from "./content";
import { DEFAULT_CHROME_LABELS } from "../../chrome-labels";

describe("buildPostContent Giphy link handling", () => {
  it("renders a Giphy watch-page link post as an inline GIF, not a dead link", async () => {
    const post = new RedditPostData({
      id: "abc123",
      permalink: "/r/test/comments/abc123/title/",
      url: "https://giphy.com/gifs/some-slug-AbC123xyz",
      is_self: false,
    });

    const { body } = await buildPostContent(post, 0, "test", DEFAULT_CHROME_LABELS);

    expect(body).toContain('<img src="https://media.giphy.com/media/AbC123xyz/giphy.gif"');
    expect(body).not.toContain("giphy.com/gifs");
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

    await expect(buildPostContent(post(), 10, "test", DEFAULT_CHROME_LABELS)).rejects.toThrow(
      ArticleSkipError,
    );
  });

  it("does not skip the article for an ordinary transport failure", async () => {
    // `fetchPostComments()` absorbs a network failure itself and answers `[]`,
    // so only the skip error reaches this caller -- the re-throw above is
    // narrow, not a blanket "let comment failures fail the article".
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("socket hang up")));

    const { comments } = await buildPostContent(post(), 10, "test", DEFAULT_CHROME_LABELS);
    expect(comments).toContain("No comments yet.");
  });
});

describe("buildPostContent crosspost attribution", () => {
  const crosspostedPost = () =>
    new RedditPostData({
      id: "abc123",
      // A crosspost's own `url` is the original post, which is why
      // `addLinkMedia()` suppresses the bare link for one.
      url: "https://www.reddit.com/r/ich_iel/comments/xyz789/title/",
      permalink: "/r/ich_iel/comments/xyz789/title/",
      is_self: false,
    });

  it("opens the body with a notice naming the subreddit the post came from", async () => {
    const { body } = await buildPostContent(
      crosspostedPost(),
      0,
      "ich_iel",
      DEFAULT_CHROME_LABELS,
      null,
      {
        originalSubreddit: "ich_iel",
      },
    );

    // The notice is first: a reader has to know what they are looking at
    // before the original post's own body starts.
    expect(body.startsWith("<p><em>Crosspost: ")).toBe(true);
    expect(body).toContain('href="https://reddit.com/r/ich_iel"');
    expect(body).toContain(">r/ich_iel<");
  });

  it("never names the feed's own subreddit, which the reader already knows", async () => {
    const { body } = await buildPostContent(
      crosspostedPost(),
      0,
      "de",
      DEFAULT_CHROME_LABELS,
      null,
      {
        originalSubreddit: "ich_iel",
      },
    );

    // "r/ich_iel -> r/de" would spend the line restating where the reader
    // already is; only the origin is news.
    expect(body).not.toContain("r/de");
    expect(body).not.toContain("→");
  });

  it("still suppresses the bare link a crosspost's own url would render", async () => {
    const withNotice = await buildPostContent(
      crosspostedPost(),
      0,
      "ich_iel",
      DEFAULT_CHROME_LABELS,
      null,
      { originalSubreddit: "ich_iel" },
    );
    const withoutNotice = await buildPostContent(
      crosspostedPost(),
      0,
      "ich_iel",
      DEFAULT_CHROME_LABELS,
    );

    // The post's `url` is not appended as a body link, exactly as before this
    // notice existed.
    expect(withNotice.body).not.toContain('href="https://www.reddit.com/r/ich_iel/comments/xyz789');
    // ...and a post that is *not* a crosspost still gets that link.
    expect(withoutNotice.body).toContain('href="https://www.reddit.com/r/ich_iel/comments/xyz789');
    expect(withoutNotice.body).not.toContain("Crosspost");
  });

  it("degrades to the bare label when no origin subreddit is known", async () => {
    const { body } = await buildPostContent(
      crosspostedPost(),
      0,
      "de",
      DEFAULT_CHROME_LABELS,
      null,
      {
        originalSubreddit: "",
      },
    );

    // Still recognizable as a crosspost, which is the whole point of it.
    expect(body.startsWith("<p><em>Crosspost</em></p>")).toBe(true);
    // No subreddit is linked -- `not.toContain("r/")` would match the
    // comments section's own permalink, which is not what this asserts.
    expect(body).not.toContain(">r/");
  });
});
