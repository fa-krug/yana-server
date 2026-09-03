import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { eq, inArray, isNotNull, ne } from "drizzle-orm";
import { getDb, writeTransaction } from "@/lib/db/client";
import { mediaRoot } from "@/lib/avatar-storage";
import { articleBlocks, articleImages, feeds } from "@/lib/db/schema";
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

  // Flat, one file per hash under `article_images/` -- deliberately not
  // sharded into subdirectories by hash prefix, a directory-fanout scheme
  // considered and rejected here. Sharding earns its keep once a directory
  // holds so many entries that listing or opening it gets slow, and it was a
  // live concern only because nothing ever removed old entries: the mark-and-
  // sweep GC in `sweepUnreferencedImages()` below now bounds this directory's
  // growth to "images actually referenced by something", so there is no
  // longer an unbounded-growth case to shard against. Sharding also has a
  // real cost of its own -- every existing flat file would need migrating to
  // its new shard path, which is why the sweep's own review called it out as
  // its own task rather than a step to fold in here. Revisit only if this
  // directory's entry count becomes a real problem on its own, not merely
  // because it *can* grow.
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

export interface ImageSweepResult {
  /** Rows (and their files) removed because nothing referenced them. */
  sweptImages: number;
}

// Mirrors INSERT_BATCH_SIZE in blocks/storage.ts, for the same reason:
// SQLITE_MAX_VARIABLE_NUMBER is 999 on some builds, and a DELETE ... WHERE
// content_hash IN (...) binds one variable per hash. 100 keeps every batch far
// under that limit regardless of how many orphans a single sweep finds.
const SWEEP_BATCH_SIZE = 100;

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

/**
 * Delete every `article_images` row (and its file) that nothing references
 * any more -- mark-and-sweep GC for the content-addressed, refcount-free image
 * store. Images are shared across articles and users by design (two feeds
 * carrying the same wire photo dedupe to one hash), so nothing can delete "one
 * article's images" on its own; this is the only place that may remove a row.
 *
 * **The reference roots, verified against the schema rather than assumed --
 * there are exactly three, the same three `GET /api/v1/images/[hash]`'s
 * `ownsHash()` checks:**
 * 1. `articleBlocks.imageRef` -- an image block's own image.
 * 2. `articleBlocks.embedThumbnailRef` -- an embed's localized poster.
 * 3. `feeds.logoImageHash` -- a feed's discovered/uploaded logo.
 *
 * No column stores a reference inside prose (unlike, say, a raw HTML blob),
 * so there is no fourth root to extract with `findImageRefs()` -- every root
 * here is a column, read directly.
 *
 * **The two block columns and the feed column do NOT use the same encoding,
 * and conflating them would delete every image on the instance.** The block
 * columns store the *full* `yana-img://<hash>` ref (see `writeBlocks()` in
 * `../blocks/storage.ts`, and `ownsHash()` above comparing via
 * `buildImageRef()`); `feeds.logoImageHash` stores the *bare* hash (see
 * `storeLogo()` in `@/lib/feeds/logo.ts`), the same encoding
 * `articleImages.contentHash` uses. So the two ref columns are stripped of
 * `IMAGE_REF_SCHEME` before joining the referenced set -- comparing them
 * un-stripped against bare content hashes would match nothing, and "matches
 * nothing" here means "every image looks unreferenced".
 */
export async function sweepUnreferencedImages(): Promise<ImageSweepResult> {
  const db = getDb();

  const referenced = new Set<string>();

  for (const row of db
    .select({ ref: articleBlocks.imageRef })
    .from(articleBlocks)
    .where(ne(articleBlocks.imageRef, ""))
    .all()) {
    if (row.ref.startsWith(IMAGE_REF_SCHEME)) {
      referenced.add(row.ref.slice(IMAGE_REF_SCHEME.length));
    }
  }

  for (const row of db
    .select({ ref: articleBlocks.embedThumbnailRef })
    .from(articleBlocks)
    .where(ne(articleBlocks.embedThumbnailRef, ""))
    .all()) {
    if (row.ref.startsWith(IMAGE_REF_SCHEME)) {
      referenced.add(row.ref.slice(IMAGE_REF_SCHEME.length));
    }
  }

  for (const row of db
    .select({ hash: feeds.logoImageHash })
    .from(feeds)
    .where(isNotNull(feeds.logoImageHash))
    .all()) {
    if (row.hash) referenced.add(row.hash);
  }

  const allImages = db
    .select({ contentHash: articleImages.contentHash, file: articleImages.file })
    .from(articleImages)
    .all();
  const orphaned = allImages.filter((row) => !referenced.has(row.contentHash));

  let sweptImages = 0;
  for (const batch of chunk(orphaned, SWEEP_BATCH_SIZE)) {
    const hashes = batch.map((row) => row.contentHash);

    // Row first, file second -- deliberately. Both writes cannot happen
    // atomically (better-sqlite3 has no async driver, so the file removal
    // cannot live inside the same synchronous writeTransaction() callback as
    // the delete), so a crash between them is possible and the two orderings
    // fail differently. Delete-then-unlink means a crash here leaves an
    // orphaned file nothing points at any more -- merely leaked, harmless,
    // and exactly the state a later sweep would have produced anyway had this
    // batch run one cycle later. Unlink-then-delete would instead risk a
    // `article_images` row surviving with no file behind it -- unservable,
    // since `GET /api/v1/images/[hash]` would `fs.readFile()` a path that no
    // longer exists and throw. Same ordering `removeAvatar()` in
    // `@/lib/account/actions.ts` already uses, for the identical reason.
    writeTransaction((tx) => {
      tx.delete(articleImages).where(inArray(articleImages.contentHash, hashes)).run();
    });

    for (const row of batch) {
      // `force: true`: the row is already gone either way, so a file that
      // was somehow already missing is not an error worth surfacing here.
      await fs.rm(path.join(mediaRoot(), row.file), { force: true });
    }

    sweptImages += batch.length;
  }

  return { sweptImages };
}
