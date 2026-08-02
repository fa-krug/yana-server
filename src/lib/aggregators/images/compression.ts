import sharp from "sharp";

export const MAX_IMAGE_WIDTH = 600;
export const MAX_IMAGE_HEIGHT = 600;
export const MAX_HEADER_IMAGE_WIDTH = 1200;
export const MAX_HEADER_IMAGE_HEIGHT = 1200;
export const JPEG_QUALITY = 95;
export const WEBP_QUALITY = 95;
export const MIN_IMAGE_SIZE = 5000; // 5KB - skip compression if smaller

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
 */
export async function compressImage(
  imageData: Buffer,
  contentType: string,
  isHeader = false,
): Promise<CompressedImageResult | null> {
  if (!imageData || imageData.length === 0) {
    return null;
  }

  try {
    if (imageData.length < MIN_IMAGE_SIZE) {
      try {
        const meta = await sharp(imageData).metadata();
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

    const maxW = isHeader ? MAX_HEADER_IMAGE_WIDTH : MAX_IMAGE_WIDTH;
    const maxH = isHeader ? MAX_HEADER_IMAGE_HEIGHT : MAX_IMAGE_HEIGHT;

    const compressedBuffer = await sharp(imageData)
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
