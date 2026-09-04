import * as cheerio from "cheerio";
import type { Element } from "domhandler";
import { RawArticle } from "../base";
import type { ChromeLabels } from "../chrome-labels";
import { isSafeUrl } from "../blocks/parser";
import {
  cleanHtml,
  removeImageByUrl,
  sanitizeClassNames,
  sanitizeUntrustedFragment,
} from "../extract/clean";
import { extractMainContentIfPresent } from "../extract/content";
import { escapeHtml, formatArticleContent } from "../extract/format";
import { YOUTUBE_IFRAME_KEEP_SELECTOR } from "../embeds/youtube-url";
import { getHeaderImageRef } from "../header/context";
import { defineSite } from "../define-site";
import { fetchHtml } from "../http/fetcher";
import { FullWebsiteAggregator, proxyYoutubeEmbeds } from "../website";

function commentSourceLink(url: string, labels: ChromeLabels): string {
  if (isSafeUrl(url)) {
    return `<a href="${escapeHtml(url)}">${labels.source}</a>`;
  }
  return labels.source;
}

function findForumUrl(html: string, articleUrl: string): string | null {
  const $ = cheerio.load(html);

  const scripts = $('script[type="application/ld+json"]');
  for (let i = 0; i < scripts.length; i++) {
    const scriptText = $(scripts.get(i)).html();
    if (!scriptText) continue;
    try {
      const data = JSON.parse(scriptText);
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        if (item && typeof item === "object" && "discussionUrl" in item) {
          const discussionUrl = String(item.discussionUrl);
          return new URL(discussionUrl, articleUrl).toString();
        }
      }
    } catch {
      continue;
    }
  }

  const commentButton = $('a[href*="/forum/"][href*="comment"], footer a[href*="/forum/"]').first();
  if (commentButton.length > 0) {
    const href = commentButton.attr("href");
    if (href) {
      try {
        return new URL(href, articleUrl).toString();
      } catch {
        // ignore
      }
    }
  }

  return null;
}

function findCommentElements($: cheerio.CheerioAPI): cheerio.Cheerio<Element> {
  const selectors = ["li.posting_element", '[id^="posting_"]', ".posting", ".a-comment"];
  for (const selector of selectors) {
    const elements = $<Element, string>(selector);
    if (elements.length > 0) {
      return elements;
    }
  }
  return $<Element, string>("");
}

function processListItemComment(
  $: cheerio.CheerioAPI,
  el: Element,
  labels: ChromeLabels,
): string | null {
  const $el = $(el);
  let author = labels.unknownAuthor;
  const authorEl = $el.find(".tree_thread_list--written_by_user, .pseudonym").first();
  if (authorEl.length > 0) {
    const text = authorEl.text().trim();
    if (text) author = text;
  }

  const titleLink = $el.find("a.posting_subject").first();
  if (titleLink.length === 0) {
    return null;
  }

  const title = titleLink.text().trim();
  const href = titleLink.attr("href") || "";
  let commentUrl = "";
  try {
    commentUrl = new URL(href, "https://www.heise.de/").toString();
  } catch {
    commentUrl = href;
  }

  return (
    `<blockquote>` +
    `<p><strong>${escapeHtml(author)}</strong> | ` +
    `${commentSourceLink(commentUrl, labels)}</p>` +
    `<div><p>${escapeHtml(title)}</p></div>` +
    `</blockquote>`
  );
}

function processFullViewComment(
  $: cheerio.CheerioAPI,
  el: Element,
  index: number,
  articleUrl: string,
  labels: ChromeLabels,
): string | null {
  const $el = $(el);
  let author = labels.unknownAuthor;
  const authorSelectors = [
    'a[href*="/forum/heise-online/Meinungen"]',
    ".pseudonym",
    ".username",
    "strong",
  ];
  for (const selector of authorSelectors) {
    const authorEl = $el.find(selector).first();
    if (authorEl.length > 0) {
      const text = authorEl.text().trim();
      if (text && text.length < 50) {
        author = text;
        break;
      }
    }
  }

  let content = "";
  const contentSelectors = [".text", ".posting-content", ".comment-body", "p"];
  for (const selector of contentSelectors) {
    const contentEl = $el.find(selector).first();
    if (contentEl.length > 0) {
      content = $.html(contentEl);
      break;
    }
  }

  if (!content) {
    return null;
  }

  const commentId = $el.attr("id") || `comment-${index}`;
  const commentUrl = `${articleUrl}#${commentId}`;

  return (
    `<blockquote>` +
    `<p><strong>${escapeHtml(author)}</strong> | ` +
    `${commentSourceLink(commentUrl, labels)}</p>` +
    `<div>${sanitizeUntrustedFragment(content)}</div>` +
    `</blockquote>`
  );
}

export class HeiseAggregator extends defineSite(FullWebsiteAggregator, {
  key: "heise",
  siteUrl: "https://www.heise.de/",
  content: ["#meldung", ".StoryContent"],
  remove: [
    ".ad-label",
    ".ad",
    ".article-sidebar",
    "section",
    "a[name='meldung.ho.bottom.zurstartseite']",
    ".a-article-header__lead",
    ".a-article-header__title",
    ".a-article-header__publish-info",
    ".a-article-header__service",
    "a-lightbox.article-image", // Main article header image
    "figure.a-article-header__image", // Main article header image (fallback)
    "div[data-component='RecommendationBox']",
    ".opt-in__content-container",
    ".a-box",
    YOUTUBE_IFRAME_KEEP_SELECTOR,
    ".a-u-inline",
    ".redakteurskuerzel",
    ".branding",
    "a-gift",
    "aside",
    "script",
    "style",
    "noscript",
    "footer",
    ".rte__list",
    "#wtma_teaser_ho_vertrieb_inline_branding",
  ],
  firstMatchOnly: true,
}) {
  override async fetchArticleContent(url: string): Promise<string> {
    let articleUrl = url;
    try {
      if (!url.includes("seite=all")) {
        articleUrl = url.includes("?") ? `${url}&seite=all` : `${url}?seite=all`;
      }
    } catch {
      // Keep original URL
    }
    return super.fetchArticleContent(articleUrl);
  }

  override async filterArticles(
    articles: RawArticle[],
    clock: () => Date = () => new Date(),
  ): Promise<RawArticle[]> {
    const baseFiltered = await super.filterArticles(articles, clock);

    const skipTerms = [
      "die Bilder der Woche",
      "Produktwerker",
      "heise-Angebot",
      "#TGIQF",
      "heise+",
      "#heiseshow:",
      "Mein Scrum ist kaputt",
      "software-architektur.tv",
      "Developer Snapshots",
    ];

    return baseFiltered.filter((article) => {
      const titleLower = (article.name || "").toLowerCase();
      return !skipTerms.some((term) => titleLower.includes(term.toLowerCase()));
    });
  }

  override async enrichArticles(articles: RawArticle[]): Promise<RawArticle[]> {
    const enriched = await super.enrichArticles(articles);

    return enriched.filter((article) => {
      const content = (article.content || "").toLowerCase();
      return !content.includes("event sourcing");
    });
  }

  /**
   * The article headline. `.a-article-header__title` is itself in
   * `selectorsToRemove` (it is stripped from the extracted body so it isn't
   * duplicated inside the content), so it has to be read from the *raw* page
   * `fetchArticleContent()` hands `sourceTitleFrom()`, before any removal runs.
   */
  protected override sourceTitleFrom($: cheerio.CheerioAPI): string | null {
    const title = $(".a-article-header__title").first().text().trim();
    return title || null;
  }

  override extractContent(html: string, article: RawArticle): string {
    const extracted = extractMainContentIfPresent(
      html,
      this.getContentSelectors(),
      this.getIgnoreSelectors(),
      this.usesFirstContentMatch,
    );

    let primary: string | null = null;
    if (extracted !== null) {
      const $ = cheerio.load(extracted);
      $("p, div, span").each((_, elem) => {
        const $elem = $(elem);
        const text = $elem.text().trim();
        const hasImg = $elem.find("img").length > 0;
        if (!text && !hasImg) {
          $elem.remove();
        }
      });

      const body = $("body");
      primary = body.length > 0 ? body.html() || "" : $.html();
    }

    // Was `return article.content || ""` on a selector miss -- see
    // `extractContentWithFallback()` in ../website for the shared,
    // three-tier ladder this now goes through instead (site selector ->
    // generic guess -> RSS summary), which is also what recovers the
    // "every paragraph sits inside a removed section" case below: `primary`
    // can be a non-null but *empty* string after the emptied-element pruning
    // above, and the ladder falls further instead of returning that emptiness
    // as-is.
    return this.extractContentWithFallback(html, article, primary);
  }

  override async processContent(html: string, article: RawArticle): Promise<string> {
    const labels = await this.chromeLabels();
    const $ = cheerio.load(html);

    await proxyYoutubeEmbeds($, labels);

    const headerData = article.header_data;
    if (headerData?.imageUrl) {
      removeImageByUrl($, headerData.imageUrl);
    }

    $("p, h1, h2, h3, h4, h5, h6, li").each((_, elem) => {
      const contents = $(elem).contents();
      const first = contents.first();
      if (first.length > 0 && first.get(0)?.type === "text") {
        const text = first.text();
        if (/^\s+/.test(text)) {
          first.replaceWith(text.replace(/^\s+/, ""));
        }
      }
      const updatedContents = $(elem).contents();
      const last = updatedContents.last();
      if (last.length > 0 && last.get(0)?.type === "text") {
        const text = last.text();
        if (/\s+$/.test(text)) {
          last.replaceWith(text.replace(/\s+$/, ""));
        }
      }
    });

    $(
      ".lable, .linkWrapper, .price, .prosHeadding, .prosText, .consHeadding, .consText, .expandTrigger, .title, h1, h2, h3, h4, h5, h6",
    ).each((_, elem) => {
      $(elem)
        .find("*")
        .addBack()
        .contents()
        .each((_, child) => {
          if (child.type === "text") {
            const text = $(child).text();
            $(child).replaceWith(text.trim());
          }
        });
    });

    sanitizeClassNames($);

    const cleaned = cleanHtml($.html());
    const headerImageUrl = headerData ? getHeaderImageRef(headerData) : null;

    let commentsHtml: string | null = null;
    const options = (this.feed.options as Record<string, unknown> | null) || {};
    const includeComments = options.include_comments !== false;
    const maxComments = typeof options.max_comments === "number" ? options.max_comments : 5;

    if (includeComments) {
      try {
        const rawHtml = article.raw_content || "";
        if (rawHtml) {
          commentsHtml = await this.extractComments(
            article.identifier,
            rawHtml,
            maxComments,
            labels,
          );
        }
      } catch (err) {
        // Selector-fragile: heise's forum markup changes without notice, so a
        // failure here is logged (matching website.ts's "no body extracted"
        // convention) rather than swallowed silently -- see the 2026-09-03
        // pipeline-review-3 Task 2 note on this catch.
        const message = `[heise] failed to extract comments for ${article.identifier}: ${
          err instanceof Error ? err.message : String(err)
        }`;
        console.warn(message);
        this.onLog?.(message);
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

  async extractComments(
    articleUrl: string,
    articleHtml: string,
    maxComments: number,
    labels: ChromeLabels,
  ): Promise<string | null> {
    const baseUrl = articleUrl.includes("heise.de/-") ? "https://www.heise.de/" : articleUrl;

    const forumUrl = findForumUrl(articleHtml, baseUrl);
    if (!forumUrl) {
      return null;
    }

    try {
      const forumHtml = await fetchHtml(forumUrl);
      const $ = cheerio.load(forumHtml);

      const commentElements = findCommentElements($);
      if (commentElements.length === 0) {
        return null;
      }

      const commentParts: string[] = [];
      const limit = Math.min(commentElements.length, maxComments);

      for (let i = 0; i < limit; i++) {
        const el = commentElements.get(i)!;
        const commentHtml =
          el.name === "li"
            ? processListItemComment($, el, labels)
            : processFullViewComment($, el, i, articleUrl, labels);
        if (commentHtml) {
          commentParts.push(commentHtml);
        }
      }

      if (commentParts.length === 0) {
        return null;
      }

      const header = `<h3><a href="${escapeHtml(forumUrl)}">${labels.comments}</a></h3>`;
      return `<section>${header}${commentParts.join("")}</section>`;
    } catch (err) {
      // Same rationale as the outer catch above: the forum page fetch or its
      // markup can fail independently of the article page itself, and this
      // is the one place in the pipeline that failure had no signal at all.
      const message = `[heise] failed to fetch/parse the comment forum at ${forumUrl}: ${
        err instanceof Error ? err.message : String(err)
      }`;
      console.warn(message);
      this.onLog?.(message);
      return null;
    }
  }
}
