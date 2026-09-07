import { buildImageRef } from "../images/store";

/**
 * Context passed to header element extraction strategies.
 */
export interface HeaderElementContext {
  url: string;
  alt?: string;
  userId?: number | null;
  onLog?: (message: string) => void;
  /**
   * The article page's HTML, when the caller has already fetched it.
   *
   * `FullWebsiteAggregator.enrichArticles()` fetches every article page for
   * its content anyway, and the og:image/page-image strategies want that same
   * page -- so without this the aggregator fetched each article twice, once
   * here and once for the content, doubling the request count against every
   * site it aggregates. Optional because not every caller has it: the
   * `article.reload` job and the RSS-only aggregators reach header extraction
   * with nothing fetched yet, and those still fall back to fetching the page.
   */
  html?: string;
}

/**
 * Data returned from header element extraction strategies.
 */
export interface HeaderElementData {
  imageBytes: Buffer;
  contentType: string;
  contentHash: string;
  imageUrl?: string | null;
}

/**
 * Return the `yana-img://` reference for a HeaderElementData object.
 */
export function getHeaderImageRef(data: HeaderElementData): string {
  return buildImageRef(data.contentHash);
}
