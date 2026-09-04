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
 * same reason and with the same number.
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
 * 25 MP covers 5000x5000 and 6000x4200 -- every press photograph an article
 * can legitimately carry, at about 100 MB decoded. Anything past that is
 * resized to 600x600 (or 1200x1200) moments later regardless, so refusing it
 * costs nothing an article needed.
 */
export const MAX_INPUT_PIXELS = 25_000_000;

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
 * Every sharp pipeline fed bytes this process did not produce goes through
 * here, so neither limit can be omitted by an individual call site.
 */
function sharpInput(imageData: Buffer) {
  return sharp(imageData, { limitInputPixels: MAX_INPUT_PIXELS }).timeout({
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

    const outputMeta = await sharp(compressedBuffer).metadata();

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
