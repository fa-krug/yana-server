import sharp from "sharp";

export const MAX_IMAGE_WIDTH = 600;
export const MAX_IMAGE_HEIGHT = 600;
export const MAX_HEADER_IMAGE_WIDTH = 1200;
export const MAX_HEADER_IMAGE_HEIGHT = 1200;
export const JPEG_QUALITY = 95;
export const WEBP_QUALITY = 95;
export const MIN_IMAGE_SIZE = 5000; // 5KB - skip compression if smaller

/**
 * Ceiling on the decoded raster, in pixels -- the same protection
 * `processAvatar()` (`@/lib/avatar-storage`) applies to an upload, for the
 * same reason.
 *
 * **A byte cap on the fetch does not bound this.** A decompression bomb is
 * small on the wire and enormous in memory: the 1 MB of flat-colour PNG the
 * test in `compression.test.ts` builds decodes to ~108 MB, and this path
 * accepts up to 64 MB *from an arbitrary remote host* named by a source
 * article's markup -- a strictly larger surface than the 2 MB, admin-created-
 * user-only avatar path that already carries these limits. libvips checks the
 * limit against the *header* dimensions, so an oversized image is refused
 * before any pixels are decoded.
 *
 * **25 MP is sized against how many of these run at once, not against one
 * image.** 25 MP is about 100 MB of decoded RGBA, and `feeds.concurrency` (4)
 * x `WORKER_CONCURRENCY` (4) means up to sixteen concurrent decodes -- so this
 * number is really a ~1.6 GB worst case, and raising it to 100 MP would make
 * that ~6.4 GB. It covers 5000x5000 and 6000x4200, which is every press
 * photograph an article can legitimately carry.
 *
 * **What a refusal here actually costs, stated plainly.** It is *not* a
 * dropped image: `compressImage()` returns `null`, and `storeImageBytes()`
 * (`./store.ts`) then stores the **original bytes**, uncompressed and
 * un-resized. So this limit is a fallback-to-unbounded-bytes rather than a
 * refusal -- the article keeps its image at full size, and the cost is disk
 * and the bytes a client downloads, not content. That is what makes 25 MP
 * safe to keep low here.
 *
 * **It was previously also the limit at the fetch-time *measure* gate, where
 * a refusal was permanent content loss.** `validateImageDataWithSharp()`
 * (`./fetcher.ts`) answers `NON_IMAGE_RESPONSE` when sharp cannot measure the
 * bytes -- a definitive "this is not an image" -- after which the article's
 * `contentHash` is written and the image is gone for the life of that source
 * article, with no repair path. Sharing this constant there meant a 45 MP
 * JPEG (5-20 MB, comfortably inside `MAX_IMAGE_FETCH_BYTES`) was dropped
 * outright where it would previously have been fetched and stored. That gate
 * reads {@link MAX_MEASURE_PIXELS} now; see its comment for why a low number
 * bought almost nothing there.
 */
export const MAX_DECODE_PIXELS = 25_000_000;

/**
 * Ceiling at a gate that only ever *measures*, never decodes -- today
 * `validateImageDataWithSharp()` in `./fetcher.ts`.
 *
 * **Why it is three orders of magnitude larger than the decode limit, rather
 * than equal to it.** A `metadata()` read parses headers for every raster
 * format, so the work is O(1) in the declared dimensions and no memory
 * proportional to them is ever allocated -- and that holds for SVG too, which
 * is the format one would expect to be rendered to be measured: a 40000x25000
 * SVG measures in about 1 ms with no measurable RSS change. A pixel limit
 * therefore earns almost nothing at this gate; it is
 * {@link SHARP_TIMEOUT_SECONDS} that does the real work there, guarding
 * librsvg against a hostile SVG whose *parse* is pathological.
 *
 * Against that, a refusal at this gate is permanent: see the last paragraph of
 * {@link MAX_DECODE_PIXELS}. So the number is set where nothing a camera, a
 * scanner or a gigapan can produce reaches it -- 1 GP is roughly thirty times
 * the largest real photograph -- and its only remaining job is to refuse a
 * declaration so absurd it cannot be an image at all. Whatever passes here
 * still meets the 25 MP decode gate downstream, where a refusal is safe.
 *
 * It is a finite number rather than `limitInputPixels: false` on purpose: the
 * tripwire in `compression.test.ts` requires *both* limits on every sharp
 * pipeline fed caller-supplied bytes, and a rule with no exceptions is the
 * only kind that catches a new call.
 */
export const MAX_MEASURE_PIXELS = 1_000_000_000;

/**
 * Wall-clock ceiling on each sharp pipeline.
 *
 * The pixel limit bounds memory but not time: a legal-sized image can still be
 * pathological (a deeply nested SVG, a highly interlaced PNG), and here the
 * caller is a background worker loop, so a pipeline that never returns is a
 * worker that never returns -- with `WORKER_CONCURRENCY` of them, four such
 * images deadlock all background work. Ten seconds is far beyond the
 * milliseconds a real article image takes.
 */
export const SHARP_TIMEOUT_SECONDS = 10;

/**
 * Every sharp pipeline in this module goes through here, so neither limit can
 * be omitted by an individual call site. Applied even to this module's own
 * webp output, where a bomb is impossible: an exception encoded here would be
 * an exception the tripwire in `compression.test.ts` has to encode too, and a
 * rule with no exceptions is the only kind that catches a *new* call.
 *
 * It is not the only guarded call in the tree, and the others do not all read
 * the same pixel limit. `validateImageDataWithSharp()` in `./fetcher.ts` is
 * the first sharp call a fetched image reaches and a helper private to this
 * module cannot cover it; it pairs {@link SHARP_TIMEOUT_SECONDS} with
 * {@link MAX_MEASURE_PIXELS}, not with the decode limit, for the reason that
 * constant states. `src/lib/feeds/logo.ts` has its own copy of this helper on
 * the decode limit. The tripwire in `compression.test.ts` scans all three
 * files, and accepts either named limit -- what it enforces is that *both*
 * kinds of limit are applied, never which number.
 */
function sharpInput(bytes: Buffer) {
  return sharp(bytes, { limitInputPixels: MAX_DECODE_PIXELS }).timeout({
    seconds: SHARP_TIMEOUT_SECONDS,
  });
}

export interface CompressedImageResult {
  data: Buffer;
  contentType: string;
  size: number;
  width: number | null;
  height: number | null;
}

/**
 * Compress and convert image to optimized format using sharp.
 *
 * Process:
 * 1. Skip re-encoding for images < 5KB while extracting width/height metadata.
 * 2. Load image with sharp.
 * 3. Resize if larger than max dimensions (never upscale).
 * 4. Convert to WebP format.
 * 5. Return compressed data and metadata.
 *
 * **The resource limits live here, not in a caller**, exactly as
 * `processAvatar()` states the rule: a caller cannot forget what it never had
 * to remember, and every future image-storing path inherits them. Both are
 * applied to every pipeline that is handed caller-supplied bytes, the
 * `metadata()` read on the small-image path included -- an image whose header
 * alone is over the limit is refused there too, and falls through to the
 * existing "dimensions unknown" branch rather than being decoded.
 */
export async function compressImage(
  imageData: Buffer,
  contentType: string,
  isHeader = false,
  maxDimensions?: { width: number; height: number },
): Promise<CompressedImageResult | null> {
  if (!imageData || imageData.length === 0) {
    return null;
  }

  try {
    if (imageData.length < MIN_IMAGE_SIZE) {
      try {
        const meta = await sharpInput(imageData).metadata();
        return {
          data: imageData,
          contentType,
          size: imageData.length,
          width: meta.width ?? null,
          height: meta.height ?? null,
        };
      } catch {
        return {
          data: imageData,
          contentType,
          size: imageData.length,
          width: null,
          height: null,
        };
      }
    }

    const maxW = maxDimensions?.width ?? (isHeader ? MAX_HEADER_IMAGE_WIDTH : MAX_IMAGE_WIDTH);
    const maxH = maxDimensions?.height ?? (isHeader ? MAX_HEADER_IMAGE_HEIGHT : MAX_IMAGE_HEIGHT);

    const compressedBuffer = await sharpInput(imageData)
      .rotate()
      .resize({
        width: maxW,
        height: maxH,
        fit: "inside",
        withoutEnlargement: true,
      })
      .webp({ quality: WEBP_QUALITY })
      .toBuffer();

    const outputMeta = await sharpInput(compressedBuffer).metadata();

    return {
      data: compressedBuffer,
      contentType: "image/webp",
      size: compressedBuffer.length,
      width: outputMeta.width ?? null,
      height: outputMeta.height ?? null,
    };
  } catch {
    return null;
  }
}
