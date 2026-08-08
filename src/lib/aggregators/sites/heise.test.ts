import { afterEach, describe, expect, it, vi } from "vitest";

import type { FeedLike } from "../base";
import { DEFAULT_CHROME_LABELS } from "../chrome-labels";
import { HeiseAggregator } from "./heise";

vi.mock("../http/fetcher", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../http/fetcher")>()),
  fetchHtml: vi.fn(),
}));

function aggregatorFor(): HeiseAggregator {
  const feed: FeedLike = { identifier: "https://www.heise.de/", dailyLimit: 20 };
  return new HeiseAggregator(feed);
}

const ARTICLE_HTML = `
  <html><body>
    <script type="application/ld+json">
    {"discussionUrl": "https://www.heise.de/forum/x/Kommentare/y/list"}
    </script>
  </body></html>
`;

const FORUM_HTML = `
  <html><body>
    <li class="posting_element" id="posting_1">
      <a class="posting_subject" href="/forum/x/y/1">A reply</a>
      <span class="pseudonym">Alex</span>
    </li>
  </body></html>
`;

describe("HeiseAggregator.extractComments", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("renders the Comments heading and source link in English by default", async () => {
    const { fetchHtml } = await import("../http/fetcher");
    vi.mocked(fetchHtml).mockResolvedValue(FORUM_HTML);

    const agg = aggregatorFor();
    const html = await agg.extractComments(
      "https://www.heise.de/a",
      ARTICLE_HTML,
      5,
      DEFAULT_CHROME_LABELS,
    );

    expect(html).toContain(">Comments</a></h3>");
    expect(html).toContain(">source</a>");
  });

  it("renders the Comments heading and source link in the passed-in locale", async () => {
    const { fetchHtml } = await import("../http/fetcher");
    vi.mocked(fetchHtml).mockResolvedValue(FORUM_HTML);

    const agg = aggregatorFor();
    const germanLabels = {
      ...DEFAULT_CHROME_LABELS,
      comments: "Kommentare",
      source: "Quelle",
    };
    const html = await agg.extractComments("https://www.heise.de/a", ARTICLE_HTML, 5, germanLabels);

    expect(html).toContain(">Kommentare</a></h3>");
    expect(html).toContain(">Quelle</a>");
    expect(html).not.toContain(">source<");
  });
});
