import { afterEach, describe, expect, it, vi } from "vitest";

import type { FeedLike, RawArticle } from "../base";
import { DEFAULT_CHROME_LABELS } from "../chrome-labels";
import { hasBodyContent } from "../website";
import { HeiseAggregator } from "./heise";

vi.mock("../http/fetcher", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../http/fetcher")>()),
  fetchHtml: vi.fn(),
}));

vi.mock("../images/store", () => ({
  storeImageRefFromUrl: vi.fn(async () => "yana-img://abc123hash"),
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

/**
 * Pipeline-review-3, Task 8: `FullWebsiteAggregator.fetchArticleContent()`
 * used to override `RssAggregator`'s without calling it, silently dropping
 * `noteSourceTitle()` for the entire family. Heise reports the headline via
 * `sourceTitleFrom()`, read off the raw fetched page -- `.a-article-header__title`
 * is itself in `selectorsToRemove`, so it must come from the page before
 * extraction strips it.
 */
describe("HeiseAggregator sourceTitle", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("reports the headline read off the fetched page", async () => {
    const { fetchHtml } = await import("../http/fetcher");
    vi.mocked(fetchHtml).mockResolvedValue(
      `<html><body><h1 class="a-article-header__title">Wer schützt Gesundheitsdaten?</h1></body></html>`,
    );

    const agg = aggregatorFor();
    expect(agg.sourceTitle).toBeNull();
    await agg.fetchArticleContent("https://www.heise.de/news/x-11416941.html");

    expect(agg.sourceTitle).toBe("Wer schützt Gesundheitsdaten?");
  });

  it("reports no source title when the page carries no matching headline", async () => {
    const { fetchHtml } = await import("../http/fetcher");
    vi.mocked(fetchHtml).mockResolvedValue(`<html><body><p>No headline here.</p></body></html>`);

    const agg = aggregatorFor();
    await agg.fetchArticleContent("https://www.heise.de/news/x-11416941.html");

    expect(agg.sourceTitle).toBeNull();
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

/**
 * Finding 5 (2026-09-03 pipeline review 1): `filterArticles()` used to call
 * `super.filterArticles(articles)` with no clock, so this override's own age
 * cutoff always read the real `Date.now()` even when a caller injected one --
 * see `BaseAggregator.filterArticles()`'s injectable `clock` parameter.
 */
describe("HeiseAggregator.filterArticles clock threading", () => {
  it("computes the age cutoff from the injected clock, not Date.now()", async () => {
    const feed: FeedLike = {
      identifier: "https://www.heise.de/",
      dailyLimit: 20,
      maxArticleAgeDays: 30,
    };
    const agg = new HeiseAggregator(feed);
    const articles: RawArticle[] = [
      {
        name: "Within 30 days of the injected clock",
        identifier: "https://example.com/a",
        raw_content: "",
        content: "",
        date: new Date("2026-07-10T00:00:00Z"),
      },
      {
        name: "Older than 30 days of the injected clock, but not of the real one",
        identifier: "https://example.com/b",
        raw_content: "",
        content: "",
        date: new Date("2020-01-01T00:00:00Z"),
      },
    ];
    const clock = () => new Date("2026-08-02T00:00:00Z");

    const filtered = await agg.filterArticles(articles, clock);

    expect(filtered.map((article) => article.name)).toEqual([
      "Within 30 days of the injected clock",
    ]);
  });
});

/**
 * Pipeline-review-3, Task 3, Finding 1: extractContent() -- via
 * extractMainContentIfPresent()/removeSelectors(), fed by
 * getIgnoreSelectors() -- runs *before* processContent()'s
 * proxyYoutubeEmbeds() ever gets a chance to recognise a YouTube iframe.
 * Heise's selectorsToRemove used to carry a bare
 * "iframe:not([src*='youtube.com']):not([src*='youtu.be'])" rule, so a
 * youtube-nocookie.com iframe -- whose src contains neither substring -- was
 * deleted during *extraction*, one stage before youtubeIdFrom() could ever
 * see it. Fixed by widening that rule (now YOUTUBE_IFRAME_KEEP_SELECTOR, the
 * shared exemption list in embeds/youtube-url.ts) to also exempt
 * youtube-nocookie.com. This test drives the real, full
 * extractContent() -> processContent() chain on the real subclass --
 * a test against a bare FullWebsiteAggregator instance (whose default
 * selectorsToRemove carries no iframe:not(...) rule at all) would not catch
 * this, because it never exercises the rule that caused the bug.
 */
describe("HeiseAggregator YouTube iframe survives extraction into a facade", () => {
  function videoArticle(): RawArticle {
    return {
      name: "Video Post",
      identifier: "https://www.heise.de/news/video-x-1234567.html",
      raw_content: "",
      content: "",
      date: new Date(),
    };
  }

  it("keeps a youtube-nocookie.com iframe through extractContent() and turns it into a facade in processContent()", async () => {
    const agg = aggregatorFor();
    const html = `
      <html><body>
        <div class="StoryContent">
          <p>Video below.</p>
          <iframe src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"></iframe>
        </div>
      </body></html>
    `;

    const extracted = agg.extractContent(html, videoArticle());
    // The bug: this used to be gone already, before processContent() ever ran.
    expect(extracted).toContain("<iframe");
    expect(extracted).toContain("youtube-nocookie.com");

    const processed = await agg.processContent(extracted, videoArticle());
    expect(processed).toContain("youtube-embed-container");
    expect(processed).toContain("dQw4w9WgXcQ");
    expect(processed).not.toContain("<iframe");
  });

  it("still drops a stray non-YouTube iframe during extraction", () => {
    const agg = aggregatorFor();
    const html = `
      <html><body>
        <div class="StoryContent">
          <p>Not a video.</p>
          <iframe src="https://evil.example.com/tracker"></iframe>
        </div>
      </body></html>
    `;

    const extracted = agg.extractContent(html, videoArticle());
    expect(extracted).not.toContain("<iframe");
  });
});
