import { describe, expect, it, vi } from "vitest";

import type { FeedLike, RawArticle } from "../../base";
import { YouTubeAggregator } from "./aggregator";
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

describe("YouTubeAggregator.buildContentHtml", () => {
  it("escapes a description containing a script tag", () => {
    const agg = aggregatorFor();
    const html = agg.buildContentHtml("<script>alert(1)</script>", [], "vid1");

    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("escapes a description containing an event-handler payload", () => {
    const agg = aggregatorFor();
    const html = agg.buildContentHtml("<img src=x onerror=alert(1)>", [], "vid1");

    expect(html).not.toContain("<img src=x onerror=alert(1)>");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("still converts plain-text newlines to <br> after escaping", () => {
    const agg = aggregatorFor();
    const html = agg.buildContentHtml("line one\nline two", [], "vid1");

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

    const html = agg.buildContentHtml("hello", comments, "vid1");

    expect(html).toContain("hello");
    expect(html).toContain("Someone");
    expect(html).toContain("<b>nice video</b>");
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
