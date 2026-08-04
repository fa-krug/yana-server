import { describe, expect, it } from "vitest";

import type { FeedLike, RawArticle } from "../../base";
import { RedditAggregator } from "./aggregator";

function article(overrides: Partial<RawArticle> = {}): RawArticle {
  return {
    name: "A video post",
    identifier: "https://reddit.com/r/test/comments/abc123/a_video_post/",
    raw_content: "",
    content: "<p>body</p>",
    date: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

function aggregatorFor(options: Record<string, unknown>): RedditAggregator {
  const feed: FeedLike = { identifier: "test", dailyLimit: 20, options };
  return new RedditAggregator(feed);
}

describe("RedditAggregator.finalizeArticles header gating", () => {
  it("emits no video header when include_header_image is false", async () => {
    const agg = aggregatorFor({ include_header_image: false });

    const [finalized] = await agg.finalizeArticles([
      article({
        _reddit_video_info: { fallbackUrl: "https://v.redd.it/a/DASH_480.mp4" },
        _reddit_header_image_url: "https://preview.redd.it/a/preview.jpg",
      }),
    ]);

    expect(finalized!.content).not.toContain("<video");
    expect(finalized!.content).not.toContain("<header");
  });

  it("emits the video header when include_header_image is left at its default", async () => {
    const agg = aggregatorFor({});

    const [finalized] = await agg.finalizeArticles([
      article({ _reddit_video_info: { fallbackUrl: "https://v.redd.it/a/DASH_480.mp4" } }),
    ]);

    expect(finalized!.content).toContain("<video");
    expect(finalized!.content).toContain("https://v.redd.it/a/DASH_480.mp4");
  });
});
