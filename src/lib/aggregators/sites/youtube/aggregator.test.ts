import { describe, expect, it } from "vitest";

import type { FeedLike, RawArticle } from "../../base";
import { YouTubeAggregator } from "./aggregator";
import type { YouTubeClient, YouTubeCommentThread } from "./client";

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
