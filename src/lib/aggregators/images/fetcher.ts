import sharp from "sharp";

export const DEFAULT_TIMEOUT_MS = 10000;
export const MAX_FETCH_BYTES = 64 * 1024 * 1024; // 64 MB cap for large GIFs
export const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

export const ACCEPTED_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/apng",
  "image/gif",
  "image/webp",
  "image/svg+xml",
  "image/x-icon",
  "image/vnd.microsoft.icon",
  "image/bmp",
  "image/tiff",
]);

export interface FetchedImageResult {
  imageData: Buffer;
  contentType: string;
}

export const NON_IMAGE_RESPONSE = Symbol("NON_IMAGE_RESPONSE");
export type NonImageResponse = typeof NON_IMAGE_RESPONSE;

/**
 * Get HTTP headers for image fetching.
 */
export function getImageHeaders(url?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "User-Agent": USER_AGENT,
    Accept: "image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    DNT: "1",
  };

  if (url) {
    try {
      const parsed = new URL(url);
      headers.Referer = `${parsed.protocol}//${parsed.host}`;
    } catch {}
  }

  return headers;
}

/**
 * Check if content type is a valid image MIME type.
 */
export function isImageContentType(contentType: string | null | undefined): boolean {
  if (!contentType) return false;
  const baseType = contentType.split(";")[0].trim().toLowerCase();
  return ACCEPTED_IMAGE_TYPES.has(baseType);
}

/**
 * Validate image data using sharp and extract metadata.
 */
export async function validateImageDataWithSharp(
  imageData: Buffer,
): Promise<{ width: number | null; height: number | null; format: string } | null> {
  try {
    const meta = await sharp(imageData).metadata();
    if (!meta.format) return null;
    return {
      width: meta.width ?? null,
      height: meta.height ?? null,
      format: meta.format,
    };
  } catch {
    return null;
  }
}

/**
 * Fetch a single image from URL, distinguishing a definitive "this is not an image"
 * answer (NON_IMAGE_RESPONSE) from a merely transient failure (null).
 */
export async function fetchImageOutcome(
  url: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<FetchedImageResult | NonImageResponse | null> {
  if (!url) return null;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await fetch(url, {
        headers: getImageHeaders(url),
        signal: controller.signal,
        redirect: "follow",
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      // HTTP error status (404, 500, 503, 429, etc.) is transient -> return null
      return null;
    }

    const rawContentType = response.headers.get("content-type") || "";
    const baseType = rawContentType.split(";")[0].trim().toLowerCase();

    if (!isImageContentType(baseType)) {
      return NON_IMAGE_RESPONSE;
    }

    const contentLengthHeader = response.headers.get("content-length");
    if (contentLengthHeader) {
      const length = parseInt(contentLengthHeader, 10);
      if (!isNaN(length) && length > MAX_FETCH_BYTES) {
        return null;
      }
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    if (buffer.length > MAX_FETCH_BYTES) {
      return null;
    }

    if (buffer.length < 100) {
      return NON_IMAGE_RESPONSE;
    }

    const validMeta = await validateImageDataWithSharp(buffer);
    if (!validMeta) {
      return NON_IMAGE_RESPONSE;
    }

    return {
      imageData: buffer,
      contentType: baseType,
    };
  } catch {
    // Network error, DNS, timeout, abort -> transient failure
    return null;
  }
}

/**
 * Fetch a single image from URL with validation. Collapses NON_IMAGE_RESPONSE to null.
 */
export async function fetchSingleImage(
  url: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<FetchedImageResult | null> {
  const result = await fetchImageOutcome(url, timeoutMs);
  return result && result !== NON_IMAGE_RESPONSE ? result : null;
}
