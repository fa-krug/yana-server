import * as cheerio from "cheerio";
import { RawArticle } from "../../base";
import { escapeHtml } from "../../extract/format";
import { storeImageRefFromUrl } from "../../images/store";
import { defineSite } from "../../define-site";
import { IFRAME_SANITIZE_SELECTOR, FullWebsiteAggregator } from "../../website";
import { extractTagesschauContent } from "./extraction";
import { extractMediaHeader, type MediaHeaderResult } from "./media";

export class TagesschauAggregator extends defineSite(FullWebsiteAggregator, {
  key: "tagesschau",
  siteUrl: "https://www.tagesschau.de",
  // No `content`: this site's body comes out of its own `extractContent()`
  // override below, so the base class's DEFAULT_CONTENT_SELECTORS stand.
  remove: [
    // Named outright rather than spread off a base-class static (there is no
    // such static any more -- see ../../define-site), the same way every other
    // site that wants it names it.
    IFRAME_SANITIZE_SELECTOR,
    "div.teaser",
    "div.socialbuttons",
    "aside",
    "nav",
    "button",
    "div.bigfive",
    "div.metatextline",
    "noscript",
    "svg",
  ],
  firstMatchOnly: true,
}) {
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
        // A *string* replacement, which is safe here only because of what
        // `ref` is: `yana-img://` plus 64 hex characters, so it cannot contain
        // `$` and nothing in it can be read as a `$&`/`$1` substitution
        // pattern. That is the same hazard `createYoutubeEmbedHtml()`
        // (`../../extract/format.ts`) had to switch to a replacer *function*
        // for, because its replacement was scraped caption markup. Anything
        // that makes this replacement value less than fully controlled --
        // falling back to the remote URL, splicing in a caption -- has to
        // switch to `() => ref` at the same time.
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
