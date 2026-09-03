import { buildImageRef } from "../images/store";

/**
 * Context passed to header element extraction strategies.
 */
export interface HeaderElementContext {
  url: string;
  alt?: string;
  onLog?: (message: string) => void;
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
