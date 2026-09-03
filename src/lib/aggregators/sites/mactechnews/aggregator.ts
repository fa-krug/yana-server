import * as cheerio from "cheerio";
import { FeedLike, RawArticle } from "../../base";
import { cleanHtml, removeImageByUrl, sanitizeClassNames } from "../../extract/clean";
import { formatArticleContent } from "../../extract/format";
import { getHeaderImageRef } from "../../header/context";
import { FirstPageStash, fetchAllPages } from "../../multipage";
import { FullWebsiteAggregator, proxyYoutubeEmbeds } from "../../website";
import { extractComments } from "./comments";
import { buildPageUrl, detectPagination } from "./multipage";

export const TECHTICKER_TITLE_PREFIX = "TechTicker:";

/**
 * Extract numeric image ID from mactechnews image URLs.
 *
 * URLs follow the pattern: Name.{numeric_id}.{ext}
 * e.g. Cover-Raumakustik.592736.jpg -> 592736
 *      Bild.592736.jpg -> 592736
 */
export function extractMtnImageId(url: string): string | null {
  const match = url.match(/\.(\d{5,})\.\w+$/);
  return match ? match[1] : null;
}

export class MactechnewsAggregator extends FullWebsiteAggregator {
  static brandSiteUrl = "https://www.mactechnews.de/";

  static getDefaultIdentifier(): string {
    return "https://www.mactechnews.de/Rss/News.x";
  }

  static getIdentifierChoices(): Array<[string, string]> {
    return [
      ["https://www.mactechnews.de/Rss/News.x", "News"],
      ["https://www.mactechnews.de/Rss/Rewind.x", "Rewind"],
      ["https://www.mactechnews.de/Rss/Journals.x", "Journals"],
    ];
  }

  static resolvesFeedUrl(): boolean {
    return false;
  }

  static getConfigurationFields(): Record<string, unknown> {
    return {
      combine_pages: {
        type: "boolean",
        initial: true,
        label: "Combine Multi-page Articles",
        help_text: "Automatically fetch and combine all pages of a multi-page article.",
        required: false,
      },
      include_comments: {
        type: "boolean",
        initial: true,
        label: "Include Comments",
        help_text: "Extract user comments from article pages.",
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
    };
  }

  static contentSelectors = [".MtnArticle"];
  protected contentSelectors = [...MactechnewsAggregator.contentSelectors];

  static selectorsToRemove = [
    ".NewsPictureMobile",
    "aside",
    "script",
    "style",
    "iframe",
    "noscript",
    "svg",
    "header",
    ".TexticonBox.Right",
  ];
  protected selectorsToRemove = [...MactechnewsAggregator.selectorsToRemove];

  usesFirstContentMatch = false;

  // Keyed by article URL, not a single field -- see `FirstPageStash`'s doc
  // comment in `../../multipage` for why: `enrichArticles()` runs
  // `fetchArticleContent()` for up to `this.concurrency` articles
  // concurrently on one aggregator instance.
  private firstPages = new FirstPageStash();

  constructor(feed: FeedLike) {
    super(feed);
    if (!this.identifier) {
      this.identifier = "https://www.mactechnews.de/Rss/News.x";
    }
  }

  override getSourceUrl(): string {
    return "https://www.mactechnews.de";
  }

  /**
   * The article headline. Called once per page fetch (this aggregator
   * paginates -- see `fetchArticleContent()` below); `noteSourceTitle()`'s
   * "sticky" rule (see ../../base) keeps an earlier page's match from being
   * blanked out by a later page that doesn't repeat the heading.
   */
  protected override sourceTitleFrom($: cheerio.CheerioAPI): string | null {
    const heading = $(".MtnArticle h1, .MtnArticle h2").first().text().trim();
    return heading || null;
  }

  override async filterArticles(
    articles: RawArticle[],
    clock: () => Date = () => new Date(),
  ): Promise<RawArticle[]> {
    const filtered = await super.filterArticles(articles, clock);
    const kept: RawArticle[] = [];
    for (const article of filtered) {
      if ((article.name || "").startsWith(TECHTICKER_TITLE_PREFIX)) {
        continue;
      }
      kept.push(article);
    }
    return kept;
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
      this.getContentSelectors(),
      (pageUrl) => super.fetchArticleContent(pageUrl),
      firstPageHtml,
      buildPageUrl,
    );

    return combined;
  }

  override async processContent(html: string, article: RawArticle): Promise<string> {
    const labels = await this.chromeLabels();
    const $ = cheerio.load(html);
    const baseUrl = article.identifier;

    // Remove content images that duplicate the header image
    const headerData = article.header_data;
    if (headerData?.imageUrl) {
      const headerImageId = extractMtnImageId(headerData.imageUrl);
      if (headerImageId) {
        $("img").each((_, img) => {
          const src = $(img).attr("src");
          if (src && extractMtnImageId(src) === headerImageId) {
            $(img).remove();
          }
        });
      }
    }

    // Resolve relative URLs for images
    $("img").each((_, img) => {
      const $img = $(img);
      const src = $img.attr("src");
      if (
        src &&
        !src.startsWith("http://") &&
        !src.startsWith("https://") &&
        !src.startsWith("data:")
      ) {
        try {
          $img.attr("src", new URL(src, baseUrl).toString());
        } catch {
          // ignore
        }
      }
    });

    // Resolve relative URLs for links
    $("a").each((_, a) => {
      const $a = $(a);
      const href = $a.attr("href");
      if (
        href &&
        !href.startsWith("http://") &&
        !href.startsWith("https://") &&
        !href.startsWith("mailto:") &&
        !href.startsWith("tel:") &&
        !href.startsWith("#")
      ) {
        try {
          $a.attr("href", new URL(href, baseUrl).toString());
        } catch {
          // ignore
        }
      }
    });

    // Replace YouTube iframes with click-through facades
    await proxyYoutubeEmbeds($, labels);

    // Remove header image from content if extracted
    if (headerData?.imageUrl) {
      removeImageByUrl($, headerData.imageUrl);
    }

    // Sanitize class names
    sanitizeClassNames($);

    // Clean HTML
    const cleaned = cleanHtml($.html());

    // Determine header image URL
    const headerImageUrl = headerData ? getHeaderImageRef(headerData) : null;

    // Retrieve and clear this article's entry unconditionally -- fetchArticleContent()
    // always records one regardless of the include_comments option, so leaving the read
    // gated behind that option would leak an entry per article on every run with
    // comments disabled.
    const firstPageHtml = this.firstPages.take(article.identifier);

    // Extract comments from the raw, un-truncated first page -- never
    // `article.raw_content`. On a multi-page article that field holds
    // `fetchAllPages()`'s `combined` result (see ../../multipage.ts), which
    // only ever contains `.MtnArticle` matches from every page and never
    // `div.MtnCommentScroll`, a sibling element outside every page's content
    // selector -- reading it here lost every multi-page article's comments.
    // Falls back to `raw_content` when nothing was stashed (combine_pages
    // off, so there was only ever one page and `raw_content` already holds
    // it in full).
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
