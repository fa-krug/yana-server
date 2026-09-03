import * as cheerio from "cheerio";
import { FeedLike, RawArticle } from "../../base";
import { isSafeUrl } from "../../blocks/parser";
import { cleanHtml, removeImageByUrl } from "../../extract/clean";
import { formatArticleContent } from "../../extract/format";
import { getHeaderImageRef } from "../../header/context";
import { storeImageRefFromUrl } from "../../images/store";
import { FirstPageStash, fetchAllPages } from "../../multipage";
import { FullWebsiteAggregator, proxyYoutubeEmbeds } from "../../website";
import { YOUTUBE_IFRAME_KEEP_SELECTOR } from "../../embeds/youtube-url";
import { extractComments } from "./comments";
import { extractMeinMmoContent, MEIN_MMO_CONTENT_SELECTORS } from "./content";
import { buildPageUrl, detectPagination } from "./multipage";

// The multi-page combine step (`fetchArticleContent()` below) selects by
// `MEIN_MMO_CONTENT_SELECTORS` (`./content.ts`) -- deliberately *not*
// `this.getContentSelectors()` (which would fold in a feed's
// `content_selectors` override). `extractMeinMmoContent()` has never read
// that override -- it hardcodes the same pair and returns the html untouched
// when neither is found -- so combining by a different selector set would
// hand it joined html it silently fails to recognise on any overridden feed,
// skipping Dailymotion-block handling, ignoreSelectors removal, embed
// processing and the "Weiter geht es auf Seite N" pagination-marker strip
// for that feed. Unifying the two sites' fetch *loop* (`../../multipage.ts`)
// does not require them to agree on selectors; making Mein-MMO honour
// `content_selectors` for real is a separate change to
// `extractMeinMmoContent()`, with its own tests.

export class MeinMmoAggregator extends FullWebsiteAggregator {
  static MEIN_MMO_URL = "https://mein-mmo.de/";
  static brandSiteUrl = "https://mein-mmo.de/";

  static getSourceUrl(): string {
    return MeinMmoAggregator.MEIN_MMO_URL;
  }

  override getSourceUrl(): string {
    return MeinMmoAggregator.MEIN_MMO_URL;
  }

  /**
   * The article headline. `h1.entry-title` is this WordPress theme's normal
   * heading; `og:title` is the fallback for the rare template that omits it.
   * Called once per page fetch (this aggregator paginates -- see
   * `fetchArticleContent()` below), and `noteSourceTitle()`'s "sticky" rule
   * (see ./base) means a later page's miss cannot blank out an earlier page's
   * match.
   */
  protected override sourceTitleFrom($: cheerio.CheerioAPI): string | null {
    const heading = $("h1.entry-title").first().text().trim();
    if (heading) return heading;
    const og = $('meta[property="og:title"]').attr("content");
    return og?.trim() || null;
  }

  static getDefaultIdentifier(): string {
    return "https://mein-mmo.de/feed/";
  }

  static getIdentifierChoices(): Array<[string, string]> {
    return [["https://mein-mmo.de/feed/", "Main Feed (All Articles)"]];
  }

  static getConfigurationFields(): Record<string, unknown> {
    return {
      combine_pages: {
        type: "boolean",
        initial: true,
        label: "Combine Multi-page Articles",
        help_text: "Automatically fetch and combine all pages of a multi-page article into one.",
        required: false,
      },
      include_comments: {
        type: "boolean",
        initial: true,
        label: "Include Comments",
        help_text: "Extract wpDiscuz reader comments from the article page.",
        required: false,
      },
      max_comments: {
        type: "number",
        initial: 5,
        label: "Max Comments",
        help_text: "Maximum number of comments to extract per article.",
        required: false,
        min_value: 0,
        max_value: 20,
      },
      include_videos: {
        type: "boolean",
        initial: false,
        label: "Include Auto-Inserted Videos",
        help_text:
          "Keep the Dailymotion player Mein-MMO's CMS drops into article bodies. " +
          "Off by default: the video it plays is chosen by the CMS, not the author, " +
          "and is often unrelated to the article.",
        required: false,
      },
    };
  }

  usesFirstContentMatch = true;

  static contentSelectors = [...MEIN_MMO_CONTENT_SELECTORS];
  protected contentSelectors = [...MeinMmoAggregator.contentSelectors];

  static selectorsToRemove = [
    "div.wp-block-mmo-recirculation-box",
    "div.wp-block-mmo-hub-box",
    // The "Inhalt" table of contents. Mein-MMO generates it with the Fixed TOC
    // (`ftwp`) WordPress plugin, which injects the whole widget -- header,
    // trigger button and the nested <ol> of anchors -- inside an otherwise
    // empty `<p class="wp-block-paragraph">` in the article body, so it is
    // extracted as article content and rendered as a stray numbered list.
    // It is navigation for the website's own page, not text: on a multi-page
    // article most of its entries are absolute links to /2/, /3/ and so on,
    // which do not exist in the aggregated article at all.
    //
    // Matched by id, and *only* this one: `div#ftwp-postcontent` is the same
    // plugin's wrapper around the ENTIRE article body, so a broader
    // `[id^='ftwp']` here would delete the article. The `<p>` left empty by
    // the removal is cleaned up by extractMeinMmoContent()'s
    // removeEmptyElements() pass.
    "div#ftwp-container-outer",
    "div.reading-position-indicator-end",
    "label.toggle",
    "a.wp-block-mmo-content-box",
    "div.page-links",
    "div.sources-wrapper",
    "div.feedback-box",
    "div.wp-block-wbd-affiliate-widget",
    "script",
    "style",
    YOUTUBE_IFRAME_KEEP_SELECTOR,
    "noscript",
    // Do NOT add ".dailymotion-embed-container" here! That is the facade
    // extractMeinMmoContent() builds for an author-inserted Dailymotion embed,
    // which is real article content. The CMS's own auto-inserted
    // "div.wp-block-mmo-video" blocks are a separate thing, and are dropped by
    // processDailymotionBlocks() when the feed's include_videos option is off
    // -- not from this list, so the removal can skip their thumbnail fetch too.
  ];
  protected selectorsToRemove = [...MeinMmoAggregator.selectorsToRemove];

  // Keyed by article URL, not a single field -- see `FirstPageStash`'s doc
  // comment in `../../multipage` for why: `enrichArticles()` runs
  // `fetchArticleContent()` for up to `this.concurrency` articles
  // concurrently on one aggregator instance, so a single field could be
  // overwritten by a sibling article's fetchArticleContent() while this
  // article's processContent() was still awaiting its img-resolution loop.
  // (This is the same shared stash MacTechNews now uses too -- see
  // ../mactechnews/aggregator.ts -- rather than a second, hand-rolled copy
  // of this same map.)
  private firstPages = new FirstPageStash();

  constructor(feed: FeedLike) {
    super(feed);
    if (!this.identifier) {
      this.identifier = "https://mein-mmo.de/feed/";
    }
  }

  override async fetchArticleContent(url: string): Promise<string> {
    const options = (this.feed.options as Record<string, unknown> | null) || {};
    const combinePages = options.combine_pages !== false;

    const firstPageHtml = await super.fetchArticleContent(url);
    this.firstPages.set(url, firstPageHtml);

    if (!combinePages) {
      return firstPageHtml;
    }

    const pageNumbers = detectPagination(firstPageHtml);
    if (pageNumbers.size <= 1) {
      return firstPageHtml;
    }

    const { combined } = await fetchAllPages(
      url,
      pageNumbers,
      MEIN_MMO_CONTENT_SELECTORS,
      (pageUrl) => super.fetchArticleContent(pageUrl),
      firstPageHtml,
      buildPageUrl,
    );

    return combined;
  }

  override async extractContent(html: string, article: RawArticle): Promise<string> {
    const labels = await this.chromeLabels();
    const options = (this.feed.options as Record<string, unknown> | null) || {};
    // `=== true`, not `!== false`, unlike combine_pages/include_comments above:
    // this option is off by default, so an absent value -- every feed created
    // before it existed -- must read as off.
    const includeVideos = options.include_videos === true;
    return extractMeinMmoContent(html, article, this.getIgnoreSelectors(), labels, includeVideos);
  }

  override async processContent(html: string, article: RawArticle): Promise<string> {
    const labels = await this.chromeLabels();
    const $ = cheerio.load(html);

    // Replace YouTube iframes with click-through facades
    await proxyYoutubeEmbeds($, labels);

    // Remove header image from content if extracted
    const headerData = article.header_data;
    if (headerData?.imageUrl) {
      removeImageByUrl($, headerData.imageUrl);
    }

    // Resolve body `<img>` sources to real yana-img:// references. A plain
    // for-of, not `.each()`: cheerio's `.each()` callback cannot be awaited,
    // and an article can carry more than one image.
    for (const imgEl of $("img").toArray()) {
      const $img = $(imgEl);
      const src = $img.attr("src");
      if (src && isSafeUrl(src)) {
        const ref = await storeImageRefFromUrl(src);
        if (ref) {
          $img.attr("src", ref);
        }
      }
    }

    const cleaned = cleanHtml($.html());
    const headerImageUrl = headerData ? getHeaderImageRef(headerData) : null;

    // Retrieve and clear this article's entry unconditionally -- fetchArticleContent()
    // always records one regardless of the include_comments option, so leaving the read
    // gated behind that option would leak an entry per article on every run with
    // comments disabled.
    const firstPageHtml = this.firstPages.take(article.identifier);

    let commentsHtml: string | null = null;
    const options = (this.feed.options as Record<string, unknown> | null) || {};
    const includeComments = options.include_comments !== false;
    const maxComments = typeof options.max_comments === "number" ? options.max_comments : 5;

    if (includeComments) {
      const commentSource = firstPageHtml || article.raw_content || "";
      if (commentSource) {
        // extractComments() never throws -- a selector-extraction failure is
        // caught and logged by the shared buildCommentsSection() it delegates
        // to (see src/lib/aggregators/comments/section.ts), rather than being
        // swallowed silently by a try/catch here.
        commentsHtml = extractComments(
          commentSource,
          article.identifier,
          maxComments,
          labels,
          this.onLog,
        );
      }
    }

    return formatArticleContent(
      cleaned,
      article.name,
      article.identifier,
      labels,
      headerImageUrl,
      null,
      commentsHtml,
    );
  }
}
