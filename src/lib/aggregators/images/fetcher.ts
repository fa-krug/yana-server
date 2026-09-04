import sharp from "sharp";

import { MAX_REDIRECTS, readCapped } from "../http/fetcher";

/**
 * The whole call's deadline -- every redirect hop and the body drain, not
 * merely the wait for headers. It was 10 s covering the headers alone, with
 * the body then read with no deadline at all; extending it to the body
 * without widening it would newly drop a large image on a slow link, so it
 * matches `http/fetcher.ts`'s own 30 s default. See `fetchBinary()` there for
 * the same pair of fixes.
 */
export const DEFAULT_TIMEOUT_MS = 30000;

/**
 * The two fetchers in this tree deliberately no longer share constant names.
 * They held `USER_AGENT` and `MAX_FETCH_BYTES` each, with different values
 * (a browser UA against `YanaBot`, 64 MB against 2 MB), so an import
 * auto-completed from the wrong module was a silent 32-fold change in the
 * byte cap that no typecheck could catch. Disjoint names make that import
 * fail to resolve instead.
 */
export const MAX_IMAGE_FETCH_BYTES = 64 * 1024 * 1024; // 64 MB cap for large GIFs
export const IMAGE_USER_AGENT =
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
    "User-Agent": IMAGE_USER_AGENT,
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
 *
 * **Redirects are followed here, bounded, rather than handed to undici with
 * `redirect: "follow"`.** An image URL comes out of a source page, so it is
 * attacker-chosen; `fetchBinary()` in `../http/fetcher.ts` has bounded hops
 * for that reason and this had none.
 *
 * **The body is read through `readCapped()`**, the same streaming cap that
 * fetcher uses, rather than buffered whole and measured afterwards. A server
 * that ignores its own `Content-Length` used to cost 64 MB of RSS per
 * in-flight image -- `feeds.concurrency` (4) x `WORKER_CONCURRENCY` (4) of
 * those is roughly a gigabyte, for a limit that had already been exceeded by
 * the time it was checked.
 *
 * Every refusal is still a `null` or `NON_IMAGE_RESPONSE`, never a throw:
 * `readCapped()`'s `ResponseTooLarge` and a redirect chain that runs out of
 * hops both land in the catch below, exactly where a network error already
 * did.
 */
export async function fetchImageOutcome(
  url: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<FetchedImageResult | NonImageResponse | null> {
  if (!url) return null;

  // One deadline for the whole call, cleared only below the body read -- see
  // DEFAULT_TIMEOUT_MS above, and fetchHtml()/fetchBinary() for the defect
  // this shape avoids.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let target = url;

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const response = await fetch(target, {
        headers: getImageHeaders(target),
        signal: controller.signal,
        redirect: "manual",
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) return null;
        target = new URL(location, target).toString();
        continue;
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

      const buffer = Buffer.from(await readCapped(response, target, MAX_IMAGE_FETCH_BYTES));

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

    // Out of hops: a chain this long is not an image worth having.
    return null;
  } catch {
    // Network error, DNS, timeout, abort, oversized body -> transient failure
    return null;
  } finally {
    clearTimeout(timer);
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
