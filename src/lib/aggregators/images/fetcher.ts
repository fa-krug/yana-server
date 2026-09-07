import sharp from "sharp";

import { MAX_REDIRECTS, readCapped, withDeadline } from "../http/fetcher";
import { noteRateLimited, parseRetryAfterMs, withHostLimit } from "../http/host-limiter";
import { MAX_MEASURE_PIXELS, SHARP_TIMEOUT_SECONDS } from "./compression";

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
 *
 * **This is the first sharp call every fetched image hits, so it carries both
 * resource limits** -- it read `sharp(imageData)` bare until the review of
 * that hardening caught it: the "no call site can forget the limits" property
 * held only inside `compression.ts`, while the bytes reaching *here* are the
 * rawest in the pipeline, straight off an arbitrary remote host, before
 * anything has decided they are an image at all.
 *
 * **The pixel limit is `MAX_MEASURE_PIXELS` (1 GP), not the 25 MP decode
 * limit, and the difference is content that used to be lost.** A refusal here
 * is not a downsize and not a retry: this function answers `null`,
 * `fetchImageOutcome()` turns that into `NON_IMAGE_RESPONSE` -- a definitive
 * "this is not an image" -- and the article's `contentHash` is then written,
 * so the image is gone for the life of that source article with no repair
 * path. Sharing `compression.ts`'s decode limit therefore dropped a 45 MP
 * JPEG outright (5-20 MB, comfortably inside `MAX_IMAGE_FETCH_BYTES`) where
 * it would previously have been fetched and stored. And it bought almost
 * nothing in exchange: a `metadata()` read parses headers rather than pixels
 * for every raster format, and measures even an SVG without rendering it, so
 * the work here is O(1) in the declared dimensions either way. What earns its
 * keep at this gate is `SHARP_TIMEOUT_SECONDS`, against a hostile SVG whose
 * parse is unbounded. See both constants' comments in `./compression.ts`.
 */
export async function validateImageDataWithSharp(
  imageData: Buffer,
): Promise<{ width: number | null; height: number | null; format: string } | null> {
  try {
    const meta = await sharp(imageData, { limitInputPixels: MAX_MEASURE_PIXELS })
      .timeout({ seconds: SHARP_TIMEOUT_SECONDS })
      .metadata();
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
 * hops both land in `fetchImageOnce()`'s catch, exactly where a network error
 * already did.
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

type ImageOutcome = FetchedImageResult | NonImageResponse | null | typeof RATE_LIMITED;

/**
 * One attempt: the bounded redirect chain, and the body of whatever it ends at.
 *
 * **Every hop takes its own `withHostLimit()` slot**, because a redirect chain
 * can cross hosts and the cap belongs to whichever one is being asked next --
 * and the body is read *inside* the slot for the reason `fetchHtmlOnce()`
 * gives: a slot released at the response headers bounds the number of open
 * sockets at nothing.
 *
 * **`timeoutMs` is one budget for the whole attempt, but only time actually in
 * flight is charged against it**, exactly as `fetchBinary()` spends its own
 * `remaining`. A single timer armed at the top of the call would also be spent
 * waiting behind the concurrency cap and any cooldown -- up to `maxCooldownMs`,
 * 60s, of deliberate politeness -- and would then abort a request that had
 * never been sent, reporting a timeout against a host that was merely being
 * queued for. So `withDeadline()` is started inside the slot, per hop, with
 * what is left; and it holds its own timer, so nothing here can disarm it above
 * the body read the way this function's hand-rolled pair once did.
 *
 * An undrained body on any of the paths that answer without reading one is
 * cancelled rather than abandoned, which would hold the socket for the whole
 * keep-alive idle timeout -- and the 429 path is, by definition, the one a
 * rate-limited host takes most often.
 */
async function fetchImageOnce(url: string, timeoutMs: number): Promise<ImageOutcome> {
  let target = url;
  let remaining = timeoutMs;

  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (remaining <= 0) return null;

      const hopUrl = target;
      const hopResult = await withHostLimit(
        hopUrl,
        async (): Promise<{ redirectTo: string } | { outcome: ImageOutcome }> => {
          const began = Date.now();
          try {
            return await withDeadline(remaining, async (signal) => {
              const response = await fetch(hopUrl, {
                headers: getImageHeaders(hopUrl),
                signal,
                redirect: "manual",
              });

              if (response.status === 429) {
                void response.body?.cancel().catch(() => {});
                noteRateLimited(hopUrl, parseRetryAfterMs(response.headers.get("retry-after")));
                return { outcome: RATE_LIMITED };
              }

              if (response.status >= 300 && response.status < 400) {
                void response.body?.cancel().catch(() => {});
                const location = response.headers.get("location");
                if (!location) return { outcome: null };
                return { redirectTo: new URL(location, hopUrl).toString() };
              }

              if (!response.ok) {
                // HTTP error status (404, 500, 503, etc.) is transient -> null
                void response.body?.cancel().catch(() => {});
                return { outcome: null };
              }

              return { outcome: await readImageResponse(response, hopUrl) };
            });
          } finally {
            remaining -= Date.now() - began;
          }
        },
      );

      if ("redirectTo" in hopResult) {
        target = hopResult.redirectTo;
        continue;
      }

      return hopResult.outcome;
    }

    // Out of hops: a chain this long is not an image worth having.
    return null;
  } catch {
    // Network error, DNS, timeout, abort, oversized body -> transient failure
    return null;
  }
}

/**
 * The content-type, size and decodability gates, applied to whatever response
 * the hop loop ended at.
 *
 * The body goes through `readCapped()` -- the same streaming cap `fetchHtml()`
 * and `fetchBinary()` use -- rather than being buffered whole and measured
 * afterwards, which is a memory hazard rather than a size check: a server that
 * ignores its own `Content-Length` cost 64 MB of RSS per in-flight image, and
 * `feeds.concurrency` (4) x `WORKER_CONCURRENCY` (4) of those is roughly a
 * gigabyte, for a limit that had already been exceeded by the time it was
 * checked. `readCapped()` also refuses an oversized *declaration* up front, so
 * the hand-rolled `Content-Length` check this replaced is not lost -- its
 * `ResponseTooLarge` lands in `fetchImageOnce()`'s catch, where a network
 * failure already did.
 */
async function readImageResponse(
  response: Response,
  url: string,
): Promise<FetchedImageResult | NonImageResponse | null> {
  const rawContentType = response.headers.get("content-type") || "";
  const baseType = rawContentType.split(";")[0].trim().toLowerCase();

  if (!isImageContentType(baseType)) {
    void response.body?.cancel().catch(() => {});
    return NON_IMAGE_RESPONSE;
  }

  const buffer = Buffer.from(await readCapped(response, url, MAX_IMAGE_FETCH_BYTES));

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
