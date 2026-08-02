import { ArticleSkipError } from "../errors";
import { getOverrideImageUrl } from "../images/extractor";
import { fetchSingleImage } from "../images/fetcher";
import { storeImageBytes } from "../images/store";
import type { HeaderElementContext, HeaderElementData } from "./context";
import {
  GenericImageStrategy,
  HeaderElementStrategy,
  RedditEmbedStrategy,
  RedditPostStrategy,
  YouTubeStrategy,
} from "./strategies";

export class HeaderElementExtractor {
  public strategies: HeaderElementStrategy[];

  constructor() {
    // CRITICAL: Strategy order MUST be RedditEmbedStrategy -> RedditPostStrategy -> YouTubeStrategy -> GenericImageStrategy
    this.strategies = [
      new RedditEmbedStrategy(),
      new RedditPostStrategy(),
      new YouTubeStrategy(),
      new GenericImageStrategy(),
    ];
  }

  async extractHeaderElement(
    url: string,
    alt = "Article image",
    userId?: number | null,
  ): Promise<HeaderElementData | null> {
    if (!url) return null;

    const overrideResult = await this.buildOverrideData(url);
    if (overrideResult) {
      return overrideResult;
    }

    const context: HeaderElementContext = { url, alt, userId };

    for (const strategy of this.strategies) {
      if (!strategy.canHandle(url)) continue;

      try {
        const result = await strategy.create(context);
        if (result) {
          return result;
        }
      } catch (e) {
        if (e instanceof ArticleSkipError) {
          throw e;
        }
      }
    }

    return null;
  }

  private async buildOverrideData(url: string): Promise<HeaderElementData | null> {
    const overrideUrl = getOverrideImageUrl(url);
    if (!overrideUrl) return null;

    const imageResult = await fetchSingleImage(overrideUrl);
    if (!imageResult) return null;

    const contentHash = await storeImageBytes(
      imageResult.imageData,
      imageResult.contentType,
      { isHeader: true },
    );
    if (!contentHash) return null;

    return {
      imageBytes: imageResult.imageData,
      contentType: imageResult.contentType,
      contentHash,
      imageUrl: overrideUrl,
    };
  }
}

export async function extractHeaderElement(
  url: string,
  alt = "Article image",
  userId?: number | null,
): Promise<HeaderElementData | null> {
  const extractor = new HeaderElementExtractor();
  return extractor.extractHeaderElement(url, alt, userId);
}
