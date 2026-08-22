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

    const html = await buildPostContent(post, 0, "test", DEFAULT_CHROME_LABELS);

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

    await expect(buildPostContent(post(), 10, "test", DEFAULT_CHROME_LABELS)).rejects.toThrow(
      ArticleSkipError,
    );
  });

  it("does not skip the article for an ordinary transport failure", async () => {
    // `fetchPostComments()` absorbs a network failure itself and answers `[]`,
    // so only the skip error reaches this caller -- the re-throw above is
    // narrow, not a blanket "let comment failures fail the article".
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("socket hang up")));

    const html = await buildPostContent(post(), 10, "test", DEFAULT_CHROME_LABELS);
    expect(html).toContain("No comments yet.");
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

  it("opens the body with a notice naming both the origin and the crosspost", async () => {
    const html = await buildPostContent(
      crosspostedPost(),
      0,
      "ich_iel",
      DEFAULT_CHROME_LABELS,
      null,
      {
        originalSubreddit: "ich_iel",
        originalPermalink: "https://reddit.com/r/ich_iel/comments/xyz789/title/",
        crosspostSubreddit: "de",
        crosspostPermalink: "https://reddit.com/r/de/comments/abc123/title/",
      },
    );

    // The notice is first: a reader has to know what they are looking at
    // before the original post's own body starts.
    expect(html.startsWith("<p><em>Crosspost: ")).toBe(true);
    expect(html).toContain('href="https://reddit.com/r/ich_iel/comments/xyz789/title/"');
    expect(html).toContain(">r/ich_iel<");
    expect(html).toContain('href="https://reddit.com/r/de/comments/abc123/title/"');
    expect(html).toContain(">r/de<");
    expect(html).toContain("→");
  });

  it("still suppresses the bare link a crosspost's own url would render", async () => {
    const withNotice = await buildPostContent(
      crosspostedPost(),
      0,
      "ich_iel",
      DEFAULT_CHROME_LABELS,
      null,
      {
        originalSubreddit: "ich_iel",
        originalPermalink: "https://reddit.com/r/ich_iel/comments/xyz789/title/",
        crosspostSubreddit: "de",
        crosspostPermalink: "https://reddit.com/r/de/comments/abc123/title/",
      },
    );
    const withoutNotice = await buildPostContent(
      crosspostedPost(),
      0,
      "ich_iel",
      DEFAULT_CHROME_LABELS,
    );

    // The notice's own links are the only occurrences; the post's `url` is
    // not appended as a body link, exactly as before this notice existed.
    expect(withNotice).not.toContain('href="https://www.reddit.com/r/ich_iel/comments/xyz789');
    // ...and a post that is *not* a crosspost still gets that link.
    expect(withoutNotice).toContain('href="https://www.reddit.com/r/ich_iel/comments/xyz789');
    expect(withoutNotice).not.toContain("Crosspost");
  });

  it("names one subreddit only when the origin and the crosspost share it", async () => {
    // `parseToRawArticles()` falls back to the feed's own subreddit when a
    // `crosspost_parent_list` entry carries no `subreddit` -- "r/x → r/x"
    // would be worse than saying nothing.
    const html = await buildPostContent(crosspostedPost(), 0, "de", DEFAULT_CHROME_LABELS, null, {
      originalSubreddit: "de",
      originalPermalink: "https://reddit.com/r/de/comments/xyz789/title/",
      crosspostSubreddit: "de",
      crosspostPermalink: "https://reddit.com/r/de/comments/abc123/title/",
    });

    expect(html).toContain(">r/de<");
    expect(html).not.toContain("→");
  });

  it("degrades to the bare label when no origin subreddit is known", async () => {
    const html = await buildPostContent(crosspostedPost(), 0, "de", DEFAULT_CHROME_LABELS, null, {
      originalSubreddit: "",
      originalPermalink: "",
      crosspostSubreddit: "de",
      crosspostPermalink: "https://reddit.com/r/de/comments/abc123/title/",
    });

    // Still recognizable as a crosspost, which is the whole point of it.
    expect(html.startsWith("<p><em>Crosspost</em></p>")).toBe(true);
    expect(html).not.toContain("r/de");
  });
});
