import * as cheerio from "cheerio";
import { FeedLike, RawArticle } from "../../base";
import { FullWebsiteAggregator } from "../../website";
import { extractTagesschauContent } from "./extraction";
import { extractMediaHeader } from "./media";

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

  override async filterArticles(articles: RawArticle[]): Promise<RawArticle[]> {
    const filtered = await super.filterArticles(articles);
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

  override extractContent(html: string, article: RawArticle): string {
    const extracted = extractTagesschauContent(html);

    if (this.hasRealContent(extracted) || this.mediaHeader(html, article)) {
      return extracted;
    }

    const generic = this.genericContentIfPresent(html, article);
    if (generic) {
      return generic;
    }

    return article.content || "";
  }

  private hasRealContent(html: string): boolean {
    const $ = cheerio.load(html);
    if ($.text().trim().length > 0) {
      return true;
    }
    return $("img, iframe, video, audio").length > 0;
  }

  private mediaHeader(html: string, article: RawArticle): string | null {
    if ("_tagesschau_media_header" in article) {
      const cached = article._tagesschau_media_header;
      return typeof cached === "string" ? cached : null;
    }

    let mediaHeader: string | null = null;
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
      return mediaHeader + processed;
    }

    return processed;
  }
}
