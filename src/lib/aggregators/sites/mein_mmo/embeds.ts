import * as cheerio from "cheerio";
import type { Element } from "domhandler";
import { isBlueskyUrl } from "../../embeds/bluesky";
import { buildYoutubeFacadeHtml, escapeHtml } from "../../extract/format";
import { isSafeUrl } from "../../blocks/parser";

export interface EmbedProcessorStrategy {
  canHandle(figure: cheerio.Cheerio<Element>, $: cheerio.CheerioAPI): boolean;
  process(figure: cheerio.Cheerio<Element>, $: cheerio.CheerioAPI): cheerio.Cheerio<Element> | null;
}

export class YouTubeEmbedProcessor implements EmbedProcessorStrategy {
  canHandle(figure: cheerio.Cheerio<Element>, _$: cheerio.CheerioAPI): boolean {
    const classStr = figure.attr("class") || "";
    const sanitizedClass = figure.attr("data-sanitized-class") || "";
    const keywords = ["wp-block-embed-youtube", "is-provider-youtube", "embed-youtube"];
    return keywords.some((kw) => classStr.includes(kw) || sanitizedClass.includes(kw));
  }

  process(
    figure: cheerio.Cheerio<Element>,
    $: cheerio.CheerioAPI,
  ): cheerio.Cheerio<Element> | null {
    const videoId = this.extractVideoId(figure, $);
    if (!videoId) return null;

    const wrapper = ($("<div>") as cheerio.Cheerio<Element>).attr(
      "data-sanitized-class",
      "youtube-embed",
    );
    const facadeHtml = buildYoutubeFacadeHtml(videoId);
    const $facade = $(facadeHtml);
    const dataEmbed = $facade.attr("data-embed");
    if (dataEmbed) {
      wrapper.attr("data-embed", dataEmbed);
    }
    wrapper.append($facade.contents());

    const figcaption = figure.find("figcaption").first();
    if (figcaption.length > 0) {
      const captionText = figcaption.text().trim();
      if (captionText) {
        wrapper.append(($("<p>") as cheerio.Cheerio<Element>).text(captionText));
      }
    }

    return wrapper;
  }

  private extractVideoId(figure: cheerio.Cheerio<Element>, $: cheerio.CheerioAPI): string | null {
    const embedContent = figure.attr("data-sanitized-data-embed-content") || "";
    if (embedContent) {
      const match = embedContent.match(
        /(?:youtube\.com\/embed\/|youtube-nocookie\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
      );
      if (match) return match[1]!;
    }

    const anchors = figure.find("a[href]").toArray();
    for (const a of anchors) {
      const href = $(a).attr("href") || "";
      const match = href.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
      if (match) return match[1]!;
    }

    return null;
  }
}

export class TwitterEmbedProcessor implements EmbedProcessorStrategy {
  canHandle(figure: cheerio.Cheerio<Element>, $: cheerio.CheerioAPI): boolean {
    const anchors = figure.find("a[href]").toArray();
    for (const a of anchors) {
      const href = $(a).attr("href") || "";
      if (href.includes("twitter.com") || href.includes("x.com")) {
        return true;
      }
    }
    return false;
  }

  process(
    figure: cheerio.Cheerio<Element>,
    $: cheerio.CheerioAPI,
  ): cheerio.Cheerio<Element> | null {
    let twitterLink: string | null = null;
    const anchors = figure.find("a[href]").toArray();
    for (const a of anchors) {
      const href = $(a).attr("href") || "";
      if (href.includes("twitter.com") || href.includes("x.com")) {
        twitterLink = href;
        break;
      }
    }

    if (!twitterLink) return null;

    const cleanUrl = twitterLink.split("?")[0]!;
    const p = $("<p>") as cheerio.Cheerio<Element>;
    const a = ($("<a>") as cheerio.Cheerio<Element>)
      .attr("href", cleanUrl)
      .attr("target", "_blank")
      .attr("rel", "noopener")
      .text(`View on X/Twitter: ${cleanUrl}`);
    p.append(a);

    const figcaption = figure.find("figcaption").first();
    if (figcaption.length > 0) {
      const captionText = figcaption.text().trim();
      if (captionText) {
        p.append("<br>").append($("<em>").text(captionText));
      }
    }

    return p;
  }
}

export class RedditEmbedProcessor implements EmbedProcessorStrategy {
  canHandle(figure: cheerio.Cheerio<Element>, _$: cheerio.CheerioAPI): boolean {
    const classStr = figure.attr("class") || "";
    const sanitizedClass = figure.attr("data-sanitized-class") || "";
    return (
      classStr.includes("provider-reddit") ||
      classStr.includes("embed-reddit") ||
      sanitizedClass.includes("provider-reddit")
    );
  }

  process(
    figure: cheerio.Cheerio<Element>,
    $: cheerio.CheerioAPI,
  ): cheerio.Cheerio<Element> | null {
    let redditLink: string | null = null;
    const anchors = figure.find("a[href]").toArray();
    for (const a of anchors) {
      const href = $(a).attr("href") || "";
      if (href.includes("reddit.com")) {
        redditLink = href;
        break;
      }
    }

    if (!redditLink) return null;

    const cleanUrl = redditLink.split("?")[0]!;
    const p = $("<p>") as cheerio.Cheerio<Element>;

    const imgTag = figure.find("img").first();
    if (imgTag.length > 0) {
      const imgSrc = imgTag.attr("src") || imgTag.attr("data-src") || "";
      if (imgSrc) {
        const imgLink = ($("<a>") as cheerio.Cheerio<Element>)
          .attr("href", cleanUrl)
          .attr("target", "_blank")
          .attr("rel", "noopener");
        const newImg = ($("<img>") as cheerio.Cheerio<Element>)
          .attr("src", imgSrc)
          .attr("alt", "Reddit post")
          .attr("style", "max-width: 100%; height: auto;");
        imgLink.append(newImg);
        p.append(imgLink).append("<br>");
      }
    }

    const a = ($("<a>") as cheerio.Cheerio<Element>)
      .attr("href", cleanUrl)
      .attr("target", "_blank")
      .attr("rel", "noopener")
      .text("View on Reddit");
    p.append(a);

    return p;
  }
}

function buildBlueskyEmbedHtmlSync(url: string): string | null {
  const cleanUrl = url.split("?")[0]!;
  if (!isSafeUrl(cleanUrl)) return null;
  return (
    `<blockquote style="border-left: 3px solid #0085ff; padding: 12px 16px; margin: 1em 0; background: #f7f9fa;">\n` +
    `<p style="margin: 0 0 8px 0;"><strong>View on Bluesky</strong> · <a href="${escapeHtml(cleanUrl)}" target="_blank" rel="noopener">View on Bluesky</a></p>\n` +
    `</blockquote>`
  );
}

export class BlueskyEmbedProcessor implements EmbedProcessorStrategy {
  canHandle(figure: cheerio.Cheerio<Element>, $: cheerio.CheerioAPI): boolean {
    const anchors = figure.find("a[href]").toArray();
    for (const a of anchors) {
      const href = $(a).attr("href") || "";
      if (isBlueskyUrl(href)) return true;
    }
    return false;
  }

  process(
    figure: cheerio.Cheerio<Element>,
    $: cheerio.CheerioAPI,
  ): cheerio.Cheerio<Element> | null {
    let blueskyLink: string | null = null;
    const anchors = figure.find("a[href]").toArray();
    for (const a of anchors) {
      const href = $(a).attr("href") || "";
      if (isBlueskyUrl(href)) {
        blueskyLink = href;
        break;
      }
    }

    if (!blueskyLink) return null;

    const embedHtml = buildBlueskyEmbedHtmlSync(blueskyLink);
    if (!embedHtml) return null;

    const wrapper = ($("<div>") as cheerio.Cheerio<Element>).attr(
      "data-sanitized-class",
      "bluesky-embed",
    );
    const $fragment = $(embedHtml);
    wrapper.append($fragment);
    return wrapper;
  }
}

export class TikTokEmbedProcessor implements EmbedProcessorStrategy {
  private static TIKTOK_EMBED_URL = "https://www.tiktok.com/embed/v3/";

  canHandle(figure: cheerio.Cheerio<Element>, _$: cheerio.CheerioAPI): boolean {
    const classStr = figure.attr("class") || "";
    const sanitizedClass = figure.attr("data-sanitized-class") || "";
    const keywords = ["wp-block-embed-tiktok", "is-provider-tiktok", "embed-tiktok"];
    return keywords.some((kw) => classStr.includes(kw) || sanitizedClass.includes(kw));
  }

  process(
    figure: cheerio.Cheerio<Element>,
    $: cheerio.CheerioAPI,
  ): cheerio.Cheerio<Element> | null {
    const videoId = this.extractVideoId(figure, $);
    if (!videoId) return null;

    const iframe = ($("<iframe>") as cheerio.Cheerio<Element>)
      .attr("src", `${TikTokEmbedProcessor.TIKTOK_EMBED_URL}${videoId}`)
      .attr("width", "325")
      .attr("height", "605")
      .attr("frameborder", "0")
      .attr("allow", "autoplay; encrypted-media")
      .attr("allowfullscreen", "true");

    const wrapper = ($("<div>") as cheerio.Cheerio<Element>)
      .attr("data-sanitized-class", "tiktok-embed")
      .append(iframe);

    const figcaption = figure.find("figcaption").first();
    if (figcaption.length > 0) {
      const captionText = figcaption.text().trim();
      if (captionText) {
        wrapper.append(($("<p>") as cheerio.Cheerio<Element>).text(captionText));
      }
    }

    return wrapper;
  }

  private extractVideoId(figure: cheerio.Cheerio<Element>, $: cheerio.CheerioAPI): string | null {
    const anchors = figure.find("a[href]").toArray();
    for (const a of anchors) {
      const href = $(a).attr("href") || "";
      if (href.includes("tiktok.com")) {
        const match = href.match(/\/video\/(\d+)/);
        if (match) return match[1]!;
      }
    }
    return null;
  }
}

export class YouTubeFallbackProcessor implements EmbedProcessorStrategy {
  canHandle(figure: cheerio.Cheerio<Element>, $: cheerio.CheerioAPI): boolean {
    const anchors = figure.find("a[href]").toArray();
    for (const a of anchors) {
      const href = $(a).attr("href") || "";
      if (href.includes("youtube.com") || href.includes("youtu.be")) {
        return true;
      }
    }
    return false;
  }

  process(
    figure: cheerio.Cheerio<Element>,
    $: cheerio.CheerioAPI,
  ): cheerio.Cheerio<Element> | null {
    let videoId: string | null = null;
    const anchors = figure.find("a[href]").toArray();
    for (const a of anchors) {
      const href = $(a).attr("href") || "";
      if (href.includes("youtube.com") || href.includes("youtu.be")) {
        const match = href.match(
          /(?:youtube\.com\/(?:watch\?v=|embed\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/,
        );
        if (match) {
          videoId = match[1]!;
          break;
        }
      }
    }

    if (!videoId) return null;

    const wrapper = ($("<div>") as cheerio.Cheerio<Element>).attr(
      "data-sanitized-class",
      "youtube-embed",
    );
    const facadeHtml = buildYoutubeFacadeHtml(videoId);
    const $facade = $(facadeHtml);
    const dataEmbed = $facade.attr("data-embed");
    if (dataEmbed) {
      wrapper.attr("data-embed", dataEmbed);
    }
    wrapper.append($facade.contents());

    const figcaption = figure.find("figcaption").first();
    if (figcaption.length > 0) {
      const captionText = figcaption.text().trim();
      if (captionText) {
        wrapper.append(($("<p>") as cheerio.Cheerio<Element>).text(captionText));
      }
    }

    return wrapper;
  }
}

/**
 * Process all figure embeds using strategy pattern.
 */
export function processEmbeds($content: cheerio.Cheerio<Element>, $: cheerio.CheerioAPI): void {
  const processors: EmbedProcessorStrategy[] = [
    new YouTubeEmbedProcessor(),
    new TwitterEmbedProcessor(),
    new RedditEmbedProcessor(),
    new BlueskyEmbedProcessor(),
    new TikTokEmbedProcessor(),
    new YouTubeFallbackProcessor(),
  ];

  const figures = $content.find("figure");
  figures.each((_, figure) => {
    const $figure = $(figure);
    for (const processor of processors) {
      if (processor.canHandle($figure, $)) {
        const replacement = processor.process($figure, $);
        if (replacement) {
          $figure.replaceWith(replacement);
        } else {
          $figure.remove();
        }
        break;
      }
    }
  });
}
