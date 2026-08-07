import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { mediaRoot } from "@/lib/avatar-storage";
import { getDb } from "@/lib/db/client";
import { articleImages } from "@/lib/db/schema/articles";
import { compressImage } from "./compression";
import { fetchImageOutcome, fetchSingleImage, NON_IMAGE_RESPONSE } from "./fetcher";

export const IMAGE_REF_SCHEME = "yana-img://";
export const TRACKING_PIXEL_MAX_DIMENSION = 1;

export const NON_CONTENT_IMAGE = Symbol("NON_CONTENT_IMAGE");
export type NonContentImage = typeof NON_CONTENT_IMAGE;

const IMAGE_REF_PATTERN = new RegExp(`${IMAGE_REF_SCHEME}([0-9a-f]{64})`, "g");

const EXTENSIONS: Record<string, string> = {
  "image/webp": "webp",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/svg+xml": "svg",
  "image/avif": "avif",
  "image/x-icon": "ico",
  "image/vnd.microsoft.icon": "ico",
};

export class ImageHashCollisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageHashCollisionError";
  }
}

/**
 * Return the yana-img:// reference for a stored image hash.
 */
export function buildImageRef(contentHash: string): string {
  return `${IMAGE_REF_SCHEME}${contentHash}`;
}

/**
 * Return every content hash referenced by a blob of HTML or text.
 */
export function findImageRefs(text: string): Set<string> {
  if (!text) return new Set();
  const hashes = new Set<string>();
  let match: RegExpExecArray | null;
  // Reset regex lastIndex for global regex execution
  const regex = new RegExp(IMAGE_REF_PATTERN);
  while ((match = regex.exec(text)) !== null) {
    if (match[1]) {
      hashes.add(match[1]);
    }
  }
  return hashes;
}

/**
 * Store image bytes and return their content hash.
 */
export async function storeImageBytes(
  imageBytes: Buffer,
  contentType: string,
  options?: {
    isHeader?: boolean;
    compress?: boolean;
    maxDimensions?: { width: number; height: number };
  },
): Promise<string | null> {
  if (!imageBytes || imageBytes.length === 0) {
    return null;
  }

  const compress = options?.compress ?? true;
  const isHeader = options?.isHeader ?? false;

  let data = imageBytes;
  let outputType = contentType;
  let width: number | null = null;
  let height: number | null = null;

  if (compress) {
    const compressed = await compressImage(
      imageBytes,
      contentType,
      isHeader,
      options?.maxDimensions,
    );
    if (compressed) {
      data = compressed.data;
      outputType = compressed.contentType;
      width = compressed.width;
      height = compressed.height;
    }
  }

  // Tracking pixel check
  if (
    width !== null &&
    height !== null &&
    width <= TRACKING_PIXEL_MAX_DIMENSION &&
    height <= TRACKING_PIXEL_MAX_DIMENSION
  ) {
    return null;
  }

  const contentHash = crypto.createHash("sha256").update(data).digest("hex");

  const existing = getDb()
    .select()
    .from(articleImages)
    .where(eq(articleImages.contentHash, contentHash))
    .get();

  if (existing) {
    if (existing.byteSize !== data.length) {
      throw new ImageHashCollisionError(
        `${contentHash} already stores ${existing.byteSize} B, refusing to overwrite it with ${data.length} B`,
      );
    }

    const filePath = path.join(mediaRoot(), existing.file);
    try {
      await fs.stat(filePath);
    } catch {
      // Missing file on disk -> write it to disk to repair
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, data);
    }

    return contentHash;
  }

  const ext = EXTENSIONS[outputType.toLowerCase()] || "bin";
  const relativeFile = `article_images/${contentHash}.${ext}`;
  const absoluteFile = path.join(mediaRoot(), relativeFile);

  await fs.mkdir(path.dirname(absoluteFile), { recursive: true });
  await fs.writeFile(absoluteFile, data);

  try {
    getDb()
      .insert(articleImages)
      .values({
        contentHash,
        file: relativeFile,
        contentType: outputType,
        width,
        height,
        byteSize: data.length,
      })
      .run();
  } catch {
    // Concurrent insert; keep existing row
  }

  return contentHash;
}

/**
 * Fetch an image from URL and store it. Returns its content hash or null.
 */
export async function storeImageFromUrl(
  url: string,
  options?: { isHeader?: boolean; maxDimensions?: { width: number; height: number } },
): Promise<string | null> {
  const fetched = await fetchSingleImage(url);
  if (!fetched) return null;

  return storeImageBytes(fetched.imageData, fetched.contentType, options);
}

/**
 * Fetch and store an image, returning its yana-img:// reference.
 */
export async function storeImageRefFromUrl(
  url: string,
  options?: { isHeader?: boolean; maxDimensions?: { width: number; height: number } },
): Promise<string | null> {
  const hash = await storeImageFromUrl(url, options);
  return hash ? buildImageRef(hash) : null;
}

/**
 * Fetch and store a body image, keeping "rejected as non-content"
 * distinguishable from a merely transient fetch failure.
 */
export async function storeBodyImageRefFromUrl(
  url: string,
): Promise<string | NonContentImage | null> {
  const fetched = await fetchImageOutcome(url);
  if (fetched === NON_IMAGE_RESPONSE) {
    return NON_CONTENT_IMAGE;
  }
  if (!fetched) {
    return null;
  }

  const contentHash = await storeImageBytes(fetched.imageData, fetched.contentType);
  if (contentHash === null) {
    return NON_CONTENT_IMAGE;
  }

  return buildImageRef(contentHash);
}
