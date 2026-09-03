import { describe, expect, it, vi } from "vitest";

import type { FeedLike, RawArticle } from "../../base";
import { DEFAULT_CHROME_LABELS } from "../../chrome-labels";
import { ARTICLE_COMMENTS_CLASS } from "../../extract/format";
import { sanitizeCommentBodyHtml, YouTubeAggregator } from "./aggregator";
import type { YouTubeClient, YouTubeCommentThread } from "./client";

// finalizeArticles() embeds a localized thumbnail via storeImageRefFromUrl,
// which otherwise fetches a real YouTube thumbnail and writes to the real
// database -- mocked here for the same reason embeds/youtube.test.ts mocks it.
vi.mock("../../images/store", () => ({
  storeImageRefFromUrl: vi.fn(async () => "yana-img://abc123hash"),
}));

function aggregatorFor(options: Record<string, unknown> = {}): YouTubeAggregator {
  const feed: FeedLike = { identifier: "UCtest", dailyLimit: 20, options };
  return new YouTubeAggregator(feed);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function enrichmentArticle(videoId: string): RawArticle {
  return {
    name: `video ${videoId}`,
    identifier: `https://www.youtube.com/watch?v=${videoId}`,
    raw_content: "",
    content: `description ${videoId}`,
    date: new Date(),
    author: "Some Channel",
    _youtube_video_id: videoId,
  };
}

describe("YouTubeAggregator.extractHeaderElement", () => {
  it("returns null without fetching anything, since processContent() never reads header_data", async () => {
    const agg = aggregatorFor();
    const article = enrichmentArticle("abc123");

    const result = await agg.extractHeaderElement(article);

    expect(result).toBeNull();
  });
});

describe("YouTubeAggregator.buildContentHtml", () => {
  it("escapes a description containing a script tag", () => {
    const agg = aggregatorFor();
    const html = agg.buildContentHtml(
      "<script>alert(1)</script>",
      [],
      "vid1",
      DEFAULT_CHROME_LABELS,
    );

    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("escapes a description containing an event-handler payload", () => {
    const agg = aggregatorFor();
    const html = agg.buildContentHtml(
      "<img src=x onerror=alert(1)>",
      [],
      "vid1",
      DEFAULT_CHROME_LABELS,
    );

    expect(html).not.toContain("<img src=x onerror=alert(1)>");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("still converts plain-text newlines to <br> after escaping", () => {
    const agg = aggregatorFor();
    const html = agg.buildContentHtml("line one\nline two", [], "vid1", DEFAULT_CHROME_LABELS);

    expect(html).toContain("line one<br>line two");
  });

  it("appends sanitized comments after the escaped description", () => {
    const agg = aggregatorFor();
    const comments: YouTubeCommentThread[] = [
      {
        id: "c1",
        snippet: {
          topLevelComment: {
            snippet: {
              authorDisplayName: "Someone",
              textDisplay: "<b>nice video</b>",
            },
          },
        },
      },
    ];

    const html = agg.buildContentHtml("hello", comments, "vid1", DEFAULT_CHROME_LABELS);

    expect(html).toContain("hello");
    expect(html).toContain("Someone");
    expect(html).toContain("<b>nice video</b>");
  });

  it("renders the Comments heading and per-comment source link in the passed-in locale's labels", () => {
    const agg = aggregatorFor();
    const comments: YouTubeCommentThread[] = [
      {
        id: "c1",
        snippet: {
          topLevelComment: {
            snippet: {
              authorDisplayName: "Someone",
              textDisplay: "nice video",
            },
          },
        },
      },
    ];

    const germanLabels = { ...DEFAULT_CHROME_LABELS, comments: "Kommentare", source: "Quelle" };
    const html = agg.buildContentHtml("hello", comments, "vid1", germanLabels);

    expect(html).toContain(">Kommentare</h3>");
    expect(html).toContain(">Quelle</a>");
    expect(html).not.toContain(">Comments<");
    expect(html).not.toContain(">source<");
  });

  it("falls back to the locale's unknownAuthor label when a comment has no author", () => {
    const agg = aggregatorFor();
    const comments: YouTubeCommentThread[] = [
      {
        id: "c1",
        snippet: {
          topLevelComment: {
            snippet: {
              textDisplay: "nice video",
            },
          },
        },
      },
    ];

    const html = agg.buildContentHtml("hello", comments, "vid1", {
      ...DEFAULT_CHROME_LABELS,
      unknownAuthor: "Unbekannt",
    });

    expect(html).toContain("<strong>Unbekannt</strong>");
  });
});

describe("YouTubeAggregator.finalizeArticles", () => {
  it("embeds each video's facade exactly once", async () => {
    const agg = aggregatorFor();
    const videoId = "dQw4w9WgXcQ";
    const article: RawArticle = {
      name: "A video",
      identifier: `https://www.youtube.com/watch?v=${videoId}`,
      raw_content: "a description",
      content: "a description",
      date: new Date(),
      author: "Some Channel",
      _youtube_video_id: videoId,
    };

    const [finalized] = await agg.finalizeArticles([article]);

    const occurrences = finalized.content.split("youtube-embed-container").length - 1;
    expect(occurrences).toBe(1);
  });
});

describe("YouTubeAggregator.logoImageUrl", () => {
  function aggregatorWithFakeClient(
    identifier: string,
    fns: Partial<Pick<YouTubeClient, "resolveChannelId" | "fetchChannelsData">>,
  ): YouTubeAggregator {
    const feed: FeedLike = { identifier, dailyLimit: 20, options: { youtube_api_key: "key" } };

    class FakeClientAggregator extends YouTubeAggregator {
      protected getClient(): YouTubeClient {
        return fns as unknown as YouTubeClient;
      }
    }

    return new FakeClientAggregator(feed);
  }

  it("resolves the handle to a channel id and returns its avatar", async () => {
    const agg = aggregatorWithFakeClient("@mkbhd", {
      resolveChannelId: async () => ["UCBJycsmduvYEL83R_U4JriQ", null],
      fetchChannelsData: async (ids) => {
        expect(ids).toEqual(["UCBJycsmduvYEL83R_U4JriQ"]);
        return [
          {
            channel_id: ids[0],
            title: "MKBHD",
            custom_url: "@mkbhd",
            uploads_playlist_id: "UUtest",
            channel_icon_url: "https://yt3.googleusercontent.com/avatar.jpg",
          },
        ];
      },
    });

    await expect(agg.logoImageUrl()).resolves.toBe("https://yt3.googleusercontent.com/avatar.jpg");
  });

  it("returns null when there is no API key configured", async () => {
    const feed: FeedLike = { identifier: "UCtest", dailyLimit: 20, options: {} };
    const agg = new YouTubeAggregator(feed);

    await expect(agg.logoImageUrl()).resolves.toBeNull();
  });

  it("returns null when the channel lookup fails", async () => {
    const agg = aggregatorWithFakeClient("@mkbhd", {
      resolveChannelId: async () => [null, "not found"],
      fetchChannelsData: async () => [],
    });

    await expect(agg.logoImageUrl()).resolves.toBeNull();
  });
});

describe("YouTubeAggregator.fetchArticleContent source title", () => {
  it("reports the video's current title", async () => {
    // What `reload.ts` sends to the AI stage instead of `articles.name`, which
    // on a feed with an AI option on is the model's own previous answer -- see
    // `noteSourceTitle()` in ../../base.
    const feed: FeedLike = { identifier: "UCtest", dailyLimit: 20, options: {} };

    class FakeClientAggregator extends YouTubeAggregator {
      protected getClient(): YouTubeClient {
        return {
          fetchVideoDetails: async () => [
            { id: "abc123", snippet: { title: "The video's current title", description: "desc" } },
          ],
          fetchVideoComments: async () => [] as YouTubeCommentThread[],
        } as unknown as YouTubeClient;
      }
    }

    const agg = new FakeClientAggregator(feed);
    expect(agg.sourceTitle).toBeNull();

    await agg.fetchArticleContent("https://www.youtube.com/watch?v=abc123");

    expect(agg.sourceTitle).toBe("The video's current title");
  });
});

describe("YouTubeAggregator.enrichArticles concurrency", () => {
  function aggregatorWithFakeClient(
    fetchVideoComments: YouTubeClient["fetchVideoComments"],
  ): YouTubeAggregator {
    const feed: FeedLike = {
      identifier: "UCtest",
      dailyLimit: 20,
      options: { comment_limit: 5 },
    };

    class FakeClientAggregator extends YouTubeAggregator {
      protected getClient(): YouTubeClient {
        return { fetchVideoComments } as unknown as YouTubeClient;
      }
    }

    return new FakeClientAggregator(feed);
  }

  it("preserves input order even when comment fetches finish out of completion order", async () => {
    const agg = aggregatorWithFakeClient(async (videoId) => {
      const delays: Record<string, number> = { "1": 30, "2": 15, "3": 0 };
      await delay(delays[videoId] ?? 0);
      return [];
    });

    const articles = [enrichmentArticle("1"), enrichmentArticle("2"), enrichmentArticle("3")];

    const result = await agg.enrichArticles(articles);

    expect(result.map((a) => a._youtube_video_id)).toEqual(["1", "2", "3"]);
    // Each article's content reflects its own description/video id, not a
    // swapped neighbor's.
    expect(result[0]!.content).toContain("description 1");
    expect(result[1]!.content).toContain("description 2");
    expect(result[2]!.content).toContain("description 3");
  });

  it("never runs more than the feed's concurrency comment fetches concurrently", async () => {
    let inFlight = 0;
    let maxInFlight = 0;

    const agg = aggregatorWithFakeClient(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await delay(10);
      inFlight--;
      return [];
    });

    const articleCount = agg.concurrency * 2 + 1;
    const articles = Array.from({ length: articleCount }, (_, i) => enrichmentArticle(`${i}`));

    const result = await agg.enrichArticles(articles);

    expect(result).toHaveLength(articleCount);
    expect(maxInFlight).toBeLessThanOrEqual(agg.concurrency);
    // Confirms the pool actually parallelizes rather than degenerating to
    // sequential execution.
    expect(maxInFlight).toBeGreaterThan(1);
  });
});

/**
 * Finding 3/4 (2026-09-03 pipeline review 1): `fetchSourceData()`'s
 * `limit || this.dailyLimit` reads an explicit `0` as "no limit given" --
 * the same inversion `base.ts`'s contract forbids (see the
 * `parseToRawArticles()` doc comment on `BaseAggregator`) -- and
 * `parseToRawArticles()` had no `limit` parameter at all to defend against a
 * source that returned more than intended.
 */
describe("YouTubeAggregator limit handling", () => {
  it("requests by the given limit even when it is zero, never falling back to dailyLimit", async () => {
    let requestedCount: number | null = null;

    class FakeClientAggregator extends YouTubeAggregator {
      protected getClient(): YouTubeClient {
        return {
          resolveChannelId: async () => ["UCtest", null],
          fetchChannelData: async () => ({
            channel_id: "UCtest",
            title: "Some Channel",
            custom_url: "@some-channel",
            uploads_playlist_id: "UUtest",
            channel_icon_url: null,
          }),
          fetchVideosFromPlaylist: async (_playlistId: string, maxResults: number) => {
            requestedCount = maxResults;
            return [];
          },
        } as unknown as YouTubeClient;
      }
    }

    const feed: FeedLike = { identifier: "UCtest", dailyLimit: 20, options: {} };
    const agg = new FakeClientAggregator(feed);

    await agg.fetchSourceData(0);

    expect(requestedCount).toBe(0);
  });

  it("slices parsed videos to the given limit, not to however many fetchSourceData returned", async () => {
    const agg = aggregatorFor();
    const videos = Array.from({ length: 10 }, (_, i) => ({
      id: `v${i}`,
      snippet: { title: `video ${i}`, description: "", publishedAt: "2026-01-01T00:00:00Z" },
    }));

    const articles = await agg.parseToRawArticles(
      { videos, channel_id: "UCtest", channel_title: "Some Channel" },
      3,
    );

    expect(articles).toHaveLength(3);
  });
});

/**
 * Finding 2 (2026-09-03 pipeline review 1): same gap as Reddit's -- Task 2's
 * fix has no test on the live call path. This drives the real production
 * wiring: `enrichArticles()` (which stashes `_youtube_comments_html`)
 * followed by `finalizeArticles()` (which calls `processContent()`, the one
 * place that reaches `formatArticleContent()`), exactly the path
 * `aggregate()` runs. `content-hash.test.ts`'s cases cannot catch a
 * regression here, since they never touch this aggregator.
 */
describe("YouTubeAggregator comments wrapper wiring", () => {
  it("wraps the stitched-in comment section in ARTICLE_COMMENTS_CLASS on the real enrich+finalize path", async () => {
    const feed: FeedLike = { identifier: "UCtest", dailyLimit: 20, options: { comment_limit: 5 } };

    class FakeClientAggregator extends YouTubeAggregator {
      protected getClient(): YouTubeClient {
        return {
          fetchVideoComments: async (): Promise<YouTubeCommentThread[]> => [
            {
              id: "c1",
              snippet: {
                topLevelComment: {
                  snippet: {
                    authorDisplayName: "Someone",
                    textDisplay: "a real comment",
                  },
                },
              },
            },
          ],
        } as unknown as YouTubeClient;
      }
    }

    const agg = new FakeClientAggregator(feed);
    const article = enrichmentArticle("abc123");

    const enriched = await agg.enrichArticles([article]);
    const [finalized] = await agg.finalizeArticles(enriched);

    expect(finalized!.content).toContain(
      `<section data-sanitized-class="${ARTICLE_COMMENTS_CLASS}">`,
    );
    expect(finalized!.content).toContain("a real comment");
  });
});

/**
 * Finding 7 (2026-09-03 pipeline review 1): `sanitizeCommentBodyHtml()` runs
 * `sanitizeHtmlAttributes()` -- which rewrites a `class` attribute into
 * `data-sanitized-class` -- and then `removeSanitizedAttributes()`
 * immediately afterward, which strips every `data-sanitized-*` attribute the
 * previous call just produced. A comment whose body carries literal markup
 * naming `<section class="article-comments">` -- the exact wrapper
 * `formatArticleContent()` uses for the real comments section, and the marker
 * `content-hash.ts`'s `withoutComments()` cuts on -- must never survive with
 * that class intact, or a comment could forge a second marker inside the real
 * wrapper and make `withoutComments()`'s `lastIndexOf` find the forged one
 * instead of the real one, permanently defeating the comment exclusion for
 * that article. This pins the current, correct behavior so a future
 * "simplification" that drops the `removeSanitizedAttributes()` call cannot
 * reopen it silently.
 */
describe("sanitizeCommentBodyHtml comment-forged comments marker", () => {
  it("never lets a comment body's own markup survive as a data-sanitized-class attribute", () => {
    const html = sanitizeCommentBodyHtml('hi <section class="article-comments">evil</section>');

    expect(html).not.toContain("data-sanitized-class");
    expect(html).not.toContain('class="article-comments"');
  });
});
