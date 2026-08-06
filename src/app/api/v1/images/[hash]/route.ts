import fs from "node:fs/promises";
import path from "node:path";

import { and, eq } from "drizzle-orm";
import { connection } from "next/server";

import { buildImageRef } from "@/lib/aggregators/images/store";
import { ApiError, apiErrorResponse, requireApiUser } from "@/lib/api/auth";
import { mediaRoot } from "@/lib/avatar-storage";
import { getDb } from "@/lib/db/client";
import { articleBlocks, articleImages, articles, feeds } from "@/lib/db/schema";

/**
 * A stored image's content hash is `crypto.createHash("sha256")` in hex --
 * see `storeImageBytes()` in `@/lib/aggregators/images/store.ts` -- so this is
 * an exact shape check, not a loose sanity check. Checked before any query
 * runs (see `GET` below): a caller sending garbage should not cost a database
 * round trip, and -- more importantly -- nothing downstream has to consider a
 * value that is not a real hex digest.
 */
const HASH_PATTERN = /^[0-9a-f]{64}$/;

/**
 * `GET /api/v1/images/<hash>` -- the native client's *and* the web UI's own
 * `<img>` tags' image-serving endpoint, following the pattern
 * `src/app/media/avatars/[userId]/route.ts` established: authenticate first,
 * answer the same 404 for every refusal reason, never sniff or trust a stored
 * content type without at least declaring `nosniff`.
 *
 * **`requireApiUser()` is what makes this dual-purpose.** Its Bearer-first,
 * cookie-second resolution (Task 8) means the native client's device-session
 * token and the web UI's ordinary session cookie both resolve to a caller
 * here, through the one route -- see `src/lib/api/auth.ts`'s doc comment for
 * why that fallback only applies when there is no `Authorization` header at
 * all.
 *
 * **Ownership is three disjoint paths, all scoped to the caller's own feeds,
 * and a hash needs only one of them to be "owned":**
 *
 * 1. **Logo**: some feed the caller owns has `feeds.logoImageHash` equal to
 *    the bare hash (Task 6 made feed logos content-addressed the same way
 *    article images already were).
 * 2. **Article body image**: some `article_blocks` row belonging to an
 *    article whose feed the caller owns has `imageRef` equal to
 *    `buildImageRef(hash)` -- the block stores the `yana-img://<hash>` *ref*
 *    string, never the bare hash, so the comparison has to go through
 *    `buildImageRef()` rather than comparing to `hash` directly.
 * 3. **Embed thumbnail**: same shape as (2), but on an embed block's
 *    `embedThumbnailRef` column instead of an image block's `imageRef` --
 *    this is what a video embed's poster (e.g. Tagesschau's player,
 *    `src/lib/aggregators/sites/tagesschau/media.ts`) is stored under, and
 *    without this path a caller's own localized video thumbnail 404s.
 *
 * Deduplication crosses users (`article_images` carries no `userId` -- see
 * its schema comment), so the same hash can legitimately be "owned" by many
 * users at once; each caller's ownership is checked independently and a hash
 * that exists but is reachable only through *another* user's feeds/articles
 * 404s exactly as a nonexistent hash would.
 *
 * `await connection()` is the literal first statement, ahead of
 * `requireApiUser()` -- this route has no other Dynamic API call in its path
 * (a Bearer-token caller never touches `next/headers`), so nothing else
 * would opt it out of prerendering. See the `connection()` bullet in the root
 * CLAUDE.md.
 */
export async function GET(
  request: Request,
  ctx: { params: Promise<{ hash: string }> },
): Promise<Response> {
  await connection();

  try {
    const user = await requireApiUser(request);

    const { hash } = await ctx.params;
    // Checked before any query touches the database -- a malformed hash can
    // never match a real content hash, so validating it first is a wasted
    // query avoided, not merely an early exit to the same answer.
    if (!HASH_PATTERN.test(hash)) throw new ApiError(404, "not_found");
    if (!ownsHash(user.id, hash)) throw new ApiError(404, "not_found");

    const image = getDb()
      .select()
      .from(articleImages)
      .where(eq(articleImages.contentHash, hash))
      .get();
    if (!image) throw new ApiError(404, "not_found");

    const bytes = await fs.readFile(path.join(mediaRoot(), image.file));
    return new Response(new Uint8Array(bytes), {
      headers: {
        "Content-Type": image.contentType,
        "Content-Length": String(bytes.byteLength),
        // Belt and braces behind that stored type, same reasoning as the
        // avatar route: never let a browser sniff its own content type.
        "X-Content-Type-Options": "nosniff",
        // Unlike the avatar route -- which explicitly declines caching until
        // it has a version token of its own -- this URL *is* the content
        // hash, so nothing can go stale under it. `private` because
        // ownership is per caller (a shared cache could serve the bytes to
        // someone this route would otherwise 404 for).
        "Cache-Control": "private, max-age=31536000, immutable",
      },
    });
  } catch (error) {
    if (error instanceof ApiError) return apiErrorResponse(error);
    throw error;
  }
}

/**
 * Does `userId` own `hash`, through a feed logo, an article body image, or an
 * embed thumbnail? Three independent, narrowly-scoped queries rather than one
 * clever join, so each path reads as exactly the sentence describing it above.
 */
function ownsHash(userId: string, hash: string): boolean {
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
