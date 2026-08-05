import { describe, expect, it } from "vitest";

import type { FeedLike } from "../../base";
import { YouTubeAggregator } from "./aggregator";
import type { YouTubeCommentThread } from "./client";

function aggregatorFor(options: Record<string, unknown> = {}): YouTubeAggregator {
  const feed: FeedLike = { identifier: "UCtest", dailyLimit: 20, options };
  return new YouTubeAggregator(feed);
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
