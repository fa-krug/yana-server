import sharp from "sharp";

import { noteRateLimited, parseRetryAfterMs, withHostLimit } from "../http/host-limiter";

export const DEFAULT_TIMEOUT_MS = 10000;
/**
 * Total attempts an image fetch gets when the host answers 429.
 *
 * Deliberately narrow: only a 429 is retried here. Every other failure was
 * already, and stays, a single-attempt `null` -- a 404 will not become a 200,
 * and a 500 or a timeout on a decorative inline image is not worth spending a
 * worker's time on twice. A 429 is different because it is a statement about
 * *when*, not about *whether*, and losing to it silently discarded the image:
 * `fetchImageOutcome()` folded it into the same transient `null` as a DNS
 * failure, so a throttled Heise run came back with articles that permanently
 * had no header image, with nothing in the log to say a retry would have
 * worked.
 */
export const RATE_LIMIT_ATTEMPTS = 3;
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

  // No sleep in this loop, deliberately: `noteRateLimited()` has already
  // pushed this host's cooldown out, and `withHostLimit()` inside the next
  // attempt waits it out. Sleeping here as well would double the delay.
  for (let attempt = 0; attempt < RATE_LIMIT_ATTEMPTS; attempt++) {
    const outcome = await fetchImageOnce(url, timeoutMs);
    if (outcome !== RATE_LIMITED) return outcome;
  }

  return null;
}

/** Sentinel for "the host answered 429", which is the one status worth retrying. */
const RATE_LIMITED = Symbol("RATE_LIMITED");

async function fetchImageOnce(
  url: string,
  timeoutMs: number,
): Promise<FetchedImageResult | NonImageResponse | null | typeof RATE_LIMITED> {
  try {
    return await withHostLimit(url, async () => {
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

      if (response.status === 429) {
        noteRateLimited(url, parseRetryAfterMs(response.headers.get("retry-after")));
        return RATE_LIMITED;
      }

      if (!response.ok) {
        // HTTP error status (404, 500, 503, etc.) is transient -> return null
        return null;
      }

      return readImageResponse(response);
    });
  } catch {
    // Network error, DNS, timeout, abort -> transient failure
    return null;
  }
}

async function readImageResponse(
  response: Response,
): Promise<FetchedImageResult | NonImageResponse | null> {
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
