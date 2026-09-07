import { and, eq } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import { articleBlocks, articles, feeds } from "@/lib/db/schema";

import { buildImageRef } from "./store";

/**
 * Does `userId` own the image stored under content hash `hash`?
 *
 * **This is the single ownership answer for every route that serves image
 * bytes**, and it is shared rather than copied for a concrete reason: two
 * routes serve the same bytes -- `GET /api/v1/images/<hash>` for the native
 * client and `GET /media/images/<hash>` for the web UI's own `<img>` tags
 * (`src/components/articles/block-node.tsx` rewrites every stored
 * `yana-img://` ref into the latter) -- and they *did* disagree: the API route
 * checked ownership and the media route checked only that *somebody* was
 * signed in, so any signed-in user who could read a hash out of a shared
 * article's blocks could read any other user's article image. A second copy of
 * this function is the shape that defect had; keep it as one.
 *
 * **Ownership is three disjoint roots, all scoped to the caller's own feeds,
 * and a hash needs only one of them to count as owned.** They are the same
 * three roots `sweepUnreferencedImages()` (`./store.ts`) scans, and for the
 * same reason: they are the only columns in the schema in which an image hash
 * can appear. **Adding a fourth place a hash can live obliges you to add it
 * here as well as to that sweep** -- missing it here 404s a legitimately owned
 * image, missing it there deletes one.
 *
 * 1. **Logo**: some feed the caller owns has `feeds.logoImageHash` equal to
 *    the bare hash.
 * 2. **Article body image**: some `article_blocks` row belonging to an article
 *    whose feed the caller owns has `imageRef` equal to `buildImageRef(hash)`.
 * 3. **Embed thumbnail**: same shape as (2), on `embedThumbnailRef` instead --
 *    a video embed's localized poster (e.g. Tagesschau's player,
 *    `../sites/tagesschau/media.ts`), which without this root would 404 for
 *    its own owner.
 *
 * **The two block columns and the feed column do not use the same encoding.**
 * The block columns store the *full* `yana-img://<hash>` ref, so those two
 * comparisons must go through `buildImageRef()`; `feeds.logoImageHash` stores
 * the *bare* hash, the same encoding `articleImages.contentHash` uses, so that
 * one compares to `hash` directly. Getting it backwards matches nothing --
 * which here reads as "not yours" and 404s every feed logo on the instance.
 *
 * Deduplication crosses users (`article_images` carries no `userId` -- see its
 * schema comment), so one hash can legitimately be owned by many users at
 * once; each caller's ownership is checked independently, and a hash that
 * exists but is reachable only through *another* user's feeds or articles must
 * be refused exactly as a nonexistent hash is. That indistinguishability is
 * the caller's obligation, not this function's: it answers a boolean, and a
 * route that answered a different status or body for "exists but not yours"
 * than for "no such hash" would be a hash-ownership oracle.
 *
 * Three independent, narrowly-scoped queries rather than one clever join, so
 * each reads as exactly the sentence describing it above.
 */
export function ownsImageHash(userId: string, hash: string): boolean {
  const db = getDb();

  const viaLogo = db
    .select({ id: feeds.id })
    .from(feeds)
    .where(and(eq(feeds.userId, userId), eq(feeds.logoImageHash, hash)))
    .get();
  if (viaLogo) return true;

  const viaArticleBlock = db
    .select({ id: articleBlocks.id })
    .from(articleBlocks)
    .innerJoin(articles, eq(articleBlocks.articleId, articles.id))
    .innerJoin(feeds, eq(articles.feedId, feeds.id))
    .where(and(eq(feeds.userId, userId), eq(articleBlocks.imageRef, buildImageRef(hash))))
    .get();
  if (viaArticleBlock) return true;

  const viaEmbedThumbnail = db
    .select({ id: articleBlocks.id })
    .from(articleBlocks)
    .innerJoin(articles, eq(articleBlocks.articleId, articles.id))
    .innerJoin(feeds, eq(articles.feedId, feeds.id))
    .where(and(eq(feeds.userId, userId), eq(articleBlocks.embedThumbnailRef, buildImageRef(hash))))
    .get();
  return Boolean(viaEmbedThumbnail);
}
