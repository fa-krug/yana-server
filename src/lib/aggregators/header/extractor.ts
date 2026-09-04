import { ArticleSkipError } from "../errors";
import { getOverrideImageUrl } from "../images/extractor";
import { fetchSingleImage } from "../images/fetcher";
import { storeImageBytes } from "../images/store";
import type { HeaderElementContext, HeaderElementData } from "./context";
import {
  GenericImageStrategy,
  HeaderElementStrategy,
  RedditPostStrategy,
  YouTubeStrategy,
} from "./strategies";

export class HeaderElementExtractor {
  public strategies: HeaderElementStrategy[];

  constructor() {
    // CRITICAL: Strategy order MUST be RedditPostStrategy -> YouTubeStrategy -> GenericImageStrategy.
    // A dedicated RedditEmbedStrategy used to run ahead of GenericImageStrategy, but every URL it
    // accepted was also accepted by GenericImageStrategy (see that class's canHandle), so it only
    // ran the generic pipeline a second time on failure -- and its bare catch swallowed
    // ArticleSkipError before it could reach the loop below. Removed; GenericImageStrategy now
    // handles reddit-embed URLs directly, and this loop's own catch is what rethrows the skip.
    this.strategies = [new RedditPostStrategy(), new YouTubeStrategy(), new GenericImageStrategy()];
  }

  async extractHeaderElement(
    url: string,
    alt = "Article image",
    onLog?: (message: string) => void,
  ): Promise<HeaderElementData | null> {
    if (!url) return null;

    const overrideResult = await this.buildOverrideData(url);
    if (overrideResult) {
      return overrideResult;
    }

    const context: HeaderElementContext = { url, alt, onLog };

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

    // Every strategy that could handle this URL either threw (swallowed
    // above) or returned null -- with nothing logged anywhere in that chain,
    // a persistently missing header image looked indistinguishable from a
    // reload that did nothing at all. `onLog`, when given, is the caller's
    // job-output channel (see reload.ts/aggregate.ts) -- console.warn alone
    // only ever reached the server log, never the job the operator is
    // actually looking at.
    const message = `[header] could not find a header image for ${url}`;
    console.warn(message);
    onLog?.(message);
    return null;
  }

  private async buildOverrideData(url: string): Promise<HeaderElementData | null> {
    const overrideUrl = getOverrideImageUrl(url);
    if (!overrideUrl) return null;

    const imageResult = await fetchSingleImage(overrideUrl);
    if (!imageResult) return null;

    const contentHash = await storeImageBytes(imageResult.imageData, imageResult.contentType, {
      isHeader: true,
    });
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
  onLog?: (message: string) => void,
): Promise<HeaderElementData | null> {
  const extractor = new HeaderElementExtractor();
  return extractor.extractHeaderElement(url, alt, onLog);
}
