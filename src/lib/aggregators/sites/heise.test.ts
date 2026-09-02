import { afterEach, describe, expect, it, vi } from "vitest";

import type { FeedLike, RawArticle } from "../base";
import { DEFAULT_CHROME_LABELS } from "../chrome-labels";
import { hasBodyContent } from "../website";
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

const FORUM_HTML_NO_AUTHOR = `
  <html><body>
    <li class="posting_element" id="posting_1">
      <a class="posting_subject" href="/forum/x/y/1">A reply</a>
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

  it("falls back to the locale's unknownAuthor label when no author element is found", async () => {
    const { fetchHtml } = await import("../http/fetcher");
    vi.mocked(fetchHtml).mockResolvedValue(FORUM_HTML_NO_AUTHOR);

    const agg = aggregatorFor();
    const html = await agg.extractComments("https://www.heise.de/a", ARTICLE_HTML, 5, {
      ...DEFAULT_CHROME_LABELS,
      unknownAuthor: "Unbekannt",
    });

    expect(html).toContain("<strong>Unbekannt</strong>");
  });
});

describe("HeiseAggregator empty-body extraction", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  // The reported case: the article container is found, but every paragraph in
  // it sits inside a <section>, which this aggregator's selectorsToRemove
  // strips wholesale. Extraction reports no error and yields no article.
  const BODY_ONLY_IN_SECTION = `
    <html><body>
      <div id="meldung">
        <section><p>All of the prose lives in here.</p></section>
      </div>
    </body></html>
  `;

  function articleFor(): RawArticle {
    return {
      name: "Wer schuetzt Gesundheitsdaten?",
      identifier: "https://www.heise.de/news/x-11416941.html",
      raw_content: "",
      content: "",
      date: new Date(),
    };
  }

  it("extracts no body when every paragraph sits inside a removed section", () => {
    const agg = aggregatorFor();

    const extracted = agg.extractContent(BODY_ONLY_IN_SECTION, articleFor());

    expect(hasBodyContent(extracted)).toBe(false);
  });

  it("skips the article rather than storing a header image with no body", async () => {
    class HeadlessHeise extends HeiseAggregator {
      override async extractHeaderElement(): Promise<null> {
        return null;
      }

      override async fetchArticleContent(): Promise<string> {
        return BODY_ONLY_IN_SECTION;
      }
    }

    const agg = new HeadlessHeise({ identifier: "https://www.heise.de/", dailyLimit: 20 });

    const result = await agg.enrichArticles([articleFor()]);

    expect(result).toEqual([]);
  });
});
