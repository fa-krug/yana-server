import * as cheerio from "cheerio";
import { FeedLike, RawArticle } from "../../base";
import { escapeHtml } from "../../extract/format";
import { storeImageRefFromUrl } from "../../images/store";
import { FullWebsiteAggregator } from "../../website";
import { extractTagesschauContent } from "./extraction";
import { extractMediaHeader, type MediaHeaderResult } from "./media";

export class TagesschauAggregator extends FullWebsiteAggregator {
  static brandSiteUrl = "https://www.tagesschau.de/";

  static getDefaultIdentifier(): string {
    return "https://www.tagesschau.de/infoservices/alle-meldungen-100~rss2.xml";
  }

  static getIdentifierChoices(): Array<[string, string]> {
    return [
      ["https://www.tagesschau.de/infoservices/alle-meldungen-100~rss2.xml", "Alle Meldungen"],
      ["https://www.tagesschau.de/index~rss2.xml", "Startseite"],
      ["https://www.tagesschau.de/inland/index~rss2.xml", "Inland"],
      ["https://www.tagesschau.de/inland/innenpolitik/index~rss2.xml", "Innenpolitik"],
      ["https://www.tagesschau.de/inland/gesellschaft/index~rss2.xml", "Gesellschaft"],
      ["https://www.tagesschau.de/inland/regional/index~rss2.xml", "Regional (Alle)"],
      [
        "https://www.tagesschau.de/inland/regional/badenwuerttemberg/index~rss2.xml",
        "Baden-Württemberg",
      ],
      ["https://www.tagesschau.de/inland/regional/bayern/index~rss2.xml", "Bayern"],
      ["https://www.tagesschau.de/inland/regional/berlin/index~rss2.xml", "Berlin"],
      ["https://www.tagesschau.de/inland/regional/brandenburg/index~rss2.xml", "Brandenburg"],
      ["https://www.tagesschau.de/inland/regional/bremen/index~rss2.xml", "Bremen"],
      ["https://www.tagesschau.de/inland/regional/hamburg/index~rss2.xml", "Hamburg"],
      ["https://www.tagesschau.de/inland/regional/hessen/index~rss2.xml", "Hessen"],
      [
        "https://www.tagesschau.de/inland/regional/mecklenburgvorpommern/index~rss2.xml",
        "Mecklenburg-Vorpommern",
      ],
      ["https://www.tagesschau.de/inland/regional/niedersachsen/index~rss2.xml", "Niedersachsen"],
      [
        "https://www.tagesschau.de/inland/regional/nordrheinwestfalen/index~rss2.xml",
        "Nordrhein-Westfalen",
      ],
      [
        "https://www.tagesschau.de/inland/regional/rheinlandpfalz/index~rss2.xml",
        "Rheinland-Pfalz",
      ],
      ["https://www.tagesschau.de/inland/regional/saarland/index~rss2.xml", "Saarland"],
      ["https://www.tagesschau.de/inland/regional/sachsen/index~rss2.xml", "Sachsen"],
      ["https://www.tagesschau.de/inland/regional/sachsenanhalt/index~rss2.xml", "Sachsen-Anhalt"],
      [
        "https://www.tagesschau.de/inland/regional/schleswigholstein/index~rss2.xml",
        "Schleswig-Holstein",
      ],
      ["https://www.tagesschau.de/inland/regional/thueringen/index~rss2.xml", "Thüringen"],
      ["https://www.tagesschau.de/ausland/index~rss2.xml", "Ausland"],
      ["https://www.tagesschau.de/ausland/europa/index~rss2.xml", "Europa"],
      ["https://www.tagesschau.de/ausland/amerika/index~rss2.xml", "Amerika"],
      ["https://www.tagesschau.de/ausland/afrika/index~rss2.xml", "Afrika"],
      ["https://www.tagesschau.de/ausland/asien/index~rss2.xml", "Asien"],
      ["https://www.tagesschau.de/ausland/ozeanien/index~rss2.xml", "Ozeanien"],
      ["https://www.tagesschau.de/wirtschaft/index~rss2.xml", "Wirtschaft"],
      ["https://www.tagesschau.de/wirtschaft/finanzen/index~rss2.xml", "Finanzen"],
      ["https://www.tagesschau.de/wirtschaft/unternehmen/index~rss2.xml", "Unternehmen"],
      ["https://www.tagesschau.de/wirtschaft/verbraucher/index~rss2.xml", "Verbraucher"],
      [
        "https://www.tagesschau.de/wirtschaft/technologie/index~rss2.xml",
        "Technologie (Wirtschaft)",
      ],
      ["https://www.tagesschau.de/wirtschaft/weltwirtschaft/index~rss2.xml", "Weltwirtschaft"],
      ["https://www.tagesschau.de/wirtschaft/konjunktur/index~rss2.xml", "Konjunktur"],
      ["https://www.tagesschau.de/wissen/index~rss2.xml", "Wissen"],
      ["https://www.tagesschau.de/wissen/gesundheit/index~rss2.xml", "Gesundheit"],
      ["https://www.tagesschau.de/wissen/klima/index~rss2.xml", "Klima & Umwelt"],
      ["https://www.tagesschau.de/wissen/forschung/index~rss2.xml", "Forschung"],
      ["https://www.tagesschau.de/wissen/technologie/index~rss2.xml", "Technologie (Wissen)"],
      ["https://www.tagesschau.de/faktenfinder/index~rss2.xml", "Faktenfinder"],
      ["https://www.tagesschau.de/investigativ/index~rss2.xml", "Investigativ"],
    ];
  }

  static getConfigurationFields(): Record<string, unknown> {
    return {
      skip_livestreams: {
        type: "boolean",
        initial: true,
        label: "Skip Livestreams",
        help_text: "Filter out articles that are just links to livestreams.",
        required: false,
      },
      skip_videos: {
        type: "boolean",
        initial: true,
        label: "Skip Videos",
        help_text: "Filter out articles that are primarily videos.",
        required: false,
      },
    };
  }

  static selectorsToRemove = [
    ...FullWebsiteAggregator.selectorsToRemove,
    "div.teaser",
    "div.socialbuttons",
    "aside",
    "nav",
    "button",
    "div.bigfive",
    "div.metatextline",
    "noscript",
    "svg",
  ];
  protected selectorsToRemove = [...TagesschauAggregator.selectorsToRemove];

  usesFirstContentMatch = true;

  constructor(feed: FeedLike) {
    super(feed);
    if (!this.identifier) {
      this.identifier = "https://www.tagesschau.de/infoservices/alle-meldungen-100~rss2.xml";
    }
  }

  override getSourceUrl(): string {
    return "https://www.tagesschau.de";
  }

  protected override sourceTitleFrom($: cheerio.CheerioAPI): string | null {
    const title = $("span.seitenkopf__headline--text").first().text().trim();
    return title || null;
  }

  override async filterArticles(
    articles: RawArticle[],
    clock: () => Date = () => new Date(),
  ): Promise<RawArticle[]> {
    const filtered = await super.filterArticles(articles, clock);
    const options = (this.feed.options as Record<string, unknown> | null) || {};
    const skipLivestreams = options.skip_livestreams !== false;
    const skipVideos = options.skip_videos !== false;

    const result: RawArticle[] = [];
    for (const article of filtered) {
      if (this.shouldSkipArticle(article, skipLivestreams, skipVideos)) {
        continue;
      }
      result.push(article);
    }
    return result;
  }

  private shouldSkipArticle(
    article: RawArticle,
    skipLivestreams: boolean,
    skipVideos: boolean,
  ): boolean {
    const title = article.name || "";
    const url = article.identifier || "";

    if (skipLivestreams && title.includes("Livestream:")) {
      return true;
    }

    if (title.startsWith("Bilder:")) {
      // Photo-gallery articles: no readable body text.
      return true;
    }

    const skipTerms = [
      "tagesschau",
      "tagesthemen",
      "11KM-Podcast",
      "Podcast 15 Minuten",
      "15 Minuten:",
    ];

    if (skipTerms.some((term) => title.includes(term))) {
      return true;
    }

    if (url.includes("bilder/blickpunkte")) {
      return true;
    }

    if (skipVideos && url.toLowerCase().includes("video")) {
      return true;
    }

    return false;
  }

  /**
   * This was the original three-tier fallback ladder (site extraction, then a
   * generic guess, then the RSS summary) -- pipeline-review-3 Task 8 promoted
   * it into the shared `extractContentWithFallback()` on `FullWebsiteAggregator`
   * (see ../../website), which every subclass's `extractContent()` now goes
   * through instead of inventing its own. `keepPrimaryRegardless` is this
   * site's one addition: `hasBodyContent()` (the shared predicate,
   * subsuming this class's own former `hasRealContent()` -- see its removal
   * below) has no way to see a media header, since it isn't part of
   * `extracted` at all; it's spliced in separately by `processContent()`.
   */
  override extractContent(html: string, article: RawArticle): string {
    const extracted = extractTagesschauContent(html);
    const keepPrimaryRegardless = this.mediaHeader(html, article) !== null;
    return this.extractContentWithFallback(html, article, extracted, keepPrimaryRegardless);
  }

  private mediaHeader(html: string, article: RawArticle): MediaHeaderResult | null {
    if ("_tagesschau_media_header" in article) {
      const cached = article._tagesschau_media_header;
      return cached && typeof cached === "object" && "html" in cached
        ? (cached as MediaHeaderResult)
        : null;
    }

    let mediaHeader: MediaHeaderResult | null = null;
    if (html) {
      try {
        mediaHeader = extractMediaHeader(html);
      } catch {
        // ignore
      }
    }

    article._tagesschau_media_header = mediaHeader;
    return mediaHeader;
  }

  /**
   * `extractMediaHeader` runs inside the synchronous `extractContent()` and
   * so cannot itself fetch the header image -- it leaves the one remote URL
   * it could not resolve on `mediaHeader.imageUrl`, already embedded
   * (escaped) in `mediaHeader.html`. This is the async step that actually
   * fetches and stores it, substituting the real `yana-img://` reference for
   * the same escaped substring. A fetch failure degrades to the original
   * remote URL already in `html` -- still a renderable image, just not
   * localized -- rather than losing the image entirely.
   */
  private async resolveMediaHeaderImage(mediaHeader: MediaHeaderResult): Promise<string> {
    if (!mediaHeader.imageUrl) {
      return mediaHeader.html;
    }
    try {
      const ref = await storeImageRefFromUrl(mediaHeader.imageUrl, { isHeader: true });
      if (ref) {
        return mediaHeader.html.replace(escapeHtml(mediaHeader.imageUrl), ref);
      }
    } catch (err) {
      console.warn(`Failed to store Tagesschau header image ${mediaHeader.imageUrl}:`, err);
    }
    return mediaHeader.html;
  }

  override async processContent(html: string, article: RawArticle): Promise<string> {
    const rawHtml = article.raw_content || "";
    const mediaHeader = this.mediaHeader(rawHtml, article);
    const headerData = article.header_data;
    if (mediaHeader && headerData) {
      article.header_data = null;
    }

    let processed: string;
    try {
      processed = await super.processContent(html, article);
    } finally {
      if (mediaHeader && headerData) {
        article.header_data = headerData;
      }
      delete article._tagesschau_media_header;
    }

    if (mediaHeader) {
      const resolvedHeaderHtml = await this.resolveMediaHeaderImage(mediaHeader);
      return resolvedHeaderHtml + processed;
    }

    return processed;
  }
}
