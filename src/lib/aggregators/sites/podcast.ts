import * as cheerio from "cheerio";
import { RawArticle } from "../base";
import { isSafeUrl } from "../blocks/parser";
import {
  cleanHtml,
  removeSanitizedAttributes,
  sanitizeClassNames,
  sanitizeHtmlAttributes,
} from "../extract/clean";
import { escapeHtml, formatArticleContent } from "../extract/format";
import { RssAggregator } from "../rss";
import { FeedEntry, ParsedFeed, unescapeEntities } from "../rss-parser";

function safeUrlAttr(url?: string | null): string | null {
  if (!url) return null;
  if (!isSafeUrl(url)) return null;
  return escapeHtml(url);
}

function sanitizeShowNotesHtml(contentHtml: string): string {
  const cleaned = cleanHtml(contentHtml);
  const $ = cheerio.load(cleaned);

  sanitizeHtmlAttributes($);
  removeSanitizedAttributes($);

  $("a").each((_, elem) => {
    const href = $(elem).attr("href");
    if (href && !isSafeUrl(href)) {
      $(elem).removeAttr("href");
    }
  });

  $("img").each((_, elem) => {
    const src = $(elem).attr("src");
    if (src && !isSafeUrl(src)) {
      $(elem).remove();
    }
  });

  const body = $("body");
  return body.length > 0 ? body.html() || "" : $.html();
}

export class PodcastAggregator extends RssAggregator {
  static getIdentifierChoices(): Array<[string, string]> {
    return [];
  }

  static getDefaultIdentifier(): string {
    return "";
  }

  static getConfigurationFields(): Record<string, unknown> {
    return {
      include_player: {
        type: "boolean",
        initial: true,
        label: "Include Audio Player",
        help_text: "Include an HTML5 audio player in the article.",
        required: false,
      },
      include_download_link: {
        type: "boolean",
        initial: true,
        label: "Include Download Link",
        help_text: "Include a direct download link for the audio file.",
        required: false,
      },
      artwork_size: {
        type: "integer",
        initial: 300,
        label: "Artwork Max Width",
        help_text: "Maximum width of the podcast artwork in pixels.",
        required: false,
        min_value: 50,
        max_value: 1000,
      },
    };
  }

  protected parseDurationToSeconds(durationStr: string): number | null {
    if (!durationStr) return null;
    const str = durationStr.trim();
    if (/^\d+$/.test(str)) {
      return parseInt(str, 10);
    }
    const parts = str.split(":");
    try {
      if (parts.length === 3) {
        return parseInt(parts[0], 10) * 3600 + parseInt(parts[1], 10) * 60 + parseInt(parts[2], 10);
      } else if (parts.length === 2) {
        return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
      }
    } catch {
      return null;
    }
    return null;
  }

  protected formatDuration(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;

    const pad = (num: number) => String(num).padStart(2, "0");

    if (hours > 0) {
      return `${hours}:${pad(minutes)}:${pad(secs)}`;
    }
    return `${minutes}:${pad(secs)}`;
  }

  override async parseToRawArticles(sourceData: unknown): Promise<RawArticle[]> {
    const feed = sourceData as ParsedFeed;
    const entries = feed?.entries || [];
    const articles: RawArticle[] = [];
    const limit = this.getCurrentRunLimit();

    const sliced = entries.slice(0, limit > 0 ? limit : entries.length);

    for (const entry of sliced) {
      let mediaUrl = "";
      let mediaType = "audio/mpeg";

      const enclosures: NonNullable<FeedEntry["enclosures"]> = entry.enclosures || [];
      if (enclosures.length > 0) {
        for (const enc of enclosures) {
          const url = String(enc.url || "");
          const mtype = String(enc.type || "");
          const urlLower = url.toLowerCase();
          const isAudioExt = [".mp3", ".m4a", ".ogg", ".opus", ".wav"].some((ext) =>
            urlLower.endsWith(ext),
          );

          if (mtype.startsWith("audio/") || isAudioExt) {
            mediaUrl = url;
            mediaType = mtype || "audio/mpeg";
            break;
          }
        }
      }

      if (!mediaUrl) {
        continue;
      }

      let duration: number | null = null;
      const durationStr = entry.itunes_duration || entry["itunes:duration"] || entry.duration;
      if (durationStr) {
        duration = this.parseDurationToSeconds(String(durationStr));
      }

      let imageUrl = "";
      const itunesImage = entry.itunes_image ?? entry["itunes:image"];
      if (itunesImage) {
        if (typeof itunesImage === "object" && itunesImage !== null) {
          imageUrl = itunesImage.href || itunesImage.url || "";
        } else {
          imageUrl = String(itunesImage);
        }
      }

      if (!imageUrl) {
        const mediaThumbnail = entry.media_thumbnail;
        if (Array.isArray(mediaThumbnail) && mediaThumbnail.length > 0) {
          imageUrl = mediaThumbnail[0]?.url || "";
        }
      }

      const article: RawArticle = {
        name: unescapeEntities(entry.title || "Untitled"),
        identifier: entry.link || "",
        raw_content: entry.summary || "",
        content: entry.summary || "",
        date: this.parseDate(entry.published),
        author: unescapeEntities(entry.author || ""),
        icon: null,
        _media_url: mediaUrl,
        _media_type: mediaType,
        _duration: duration,
        _image_url: imageUrl,
      };

      articles.push(article);
    }

    return articles;
  }

  override async enrichArticles(articles: RawArticle[]): Promise<RawArticle[]> {
    const options = (this.feed.options as Record<string, unknown> | null) || {};
    const includePlayer = options.include_player !== false;
    const includeDownloadLink = options.include_download_link !== false;
    const artworkSize = (options.artwork_size as number) ?? 300;

    const enriched: RawArticle[] = [];

    for (const article of articles) {
      const mediaUrl = article._media_url as string | undefined;
      if (!mediaUrl) {
        enriched.push(article);
        continue;
      }

      const safeMediaUrl = safeUrlAttr(mediaUrl);
      const htmlParts: string[] = [];

      const safeImageUrl = safeUrlAttr(article._image_url as string | undefined);
      if (safeImageUrl) {
        htmlParts.push(
          `<div data-sanitized-class="podcast-artwork" style="margin-bottom: 1em;">` +
            `<img src="${safeImageUrl}" alt="Episode artwork" ` +
            `style="max-width: ${artworkSize}px; height: auto; border-radius: 8px;">` +
            `</div>`,
        );
      }

      const playerRendered = includePlayer && safeMediaUrl !== null;
      if (playerRendered) {
        const mediaType = (article._media_type as string) || "audio/mpeg";
        htmlParts.push(
          `<div data-sanitized-class="podcast-player" style="margin-bottom: 1em;">` +
            `<audio controls preload="metadata" style="width: 100%;">` +
            `<source src="${safeMediaUrl}" type="${escapeHtml(mediaType)}">` +
            `Your browser does not support the audio element.` +
            `</audio>`,
        );
      }

      const metaParts: string[] = [];
      const duration = article._duration as number | null | undefined;
      if (duration) {
        metaParts.push(
          `<span data-sanitized-class="podcast-duration">Duration: ` +
            `${escapeHtml(this.formatDuration(duration))}</span>`,
        );
      }

      if (includeDownloadLink) {
        if (safeMediaUrl) {
          metaParts.push(
            `<a href="${safeMediaUrl}" data-sanitized-class="podcast-download" ` +
              `download>Download Episode</a>`,
          );
        } else {
          metaParts.push(`<span data-sanitized-class="podcast-download">Download Episode</span>`);
        }
      }

      if ((includePlayer || includeDownloadLink) && metaParts.length > 0) {
        htmlParts.push(
          `<div style="margin-top: 0.5em; font-size: 0.9em; color: #666;">` +
            `${metaParts.join(" | ")}` +
            `</div>`,
        );
      }

      if (playerRendered) {
        htmlParts.push("</div>");
      }

      const description = article.content || "";
      if (description) {
        htmlParts.push(`<div data-sanitized-class="podcast-description">`);
        htmlParts.push(`<h4>Show Notes</h4>`);
        htmlParts.push(sanitizeShowNotesHtml(description));
        htmlParts.push(`</div>`);
      }

      const combinedHtml = htmlParts.join("\n");
      article.content = await this.processContent(combinedHtml, article);
      enriched.push(article);
    }

    return enriched;
  }

  override processContent(htmlContent: string, article: RawArticle): string {
    if (!htmlContent) {
      return "";
    }

    const $ = cheerio.load(htmlContent);
    sanitizeClassNames($);
    const cleaned = cleanHtml($.html());

    return formatArticleContent(cleaned, article.name, article.identifier);
  }
}
