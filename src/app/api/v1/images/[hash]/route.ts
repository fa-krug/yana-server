import fs from "node:fs/promises";
import path from "node:path";

import { eq } from "drizzle-orm";
import { connection } from "next/server";

import { ownsImageHash } from "@/lib/aggregators/images/ownership";
import { ApiError, apiErrorResponse, requireApiUser } from "@/lib/api/auth";
import { mediaRoot } from "@/lib/avatar-storage";
import { getDb } from "@/lib/db/client";
import { articleImages } from "@/lib/db/schema";

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
 * **Ownership is not decided here.** `ownsImageHash()`
 * (`@/lib/aggregators/images/ownership.ts`) owns that answer -- its three
 * reference roots, their two different hash encodings, and why a hash owned
 * only by another user must 404 exactly as a nonexistent one does -- and it is
 * shared with `src/app/media/images/[hash]/route.ts`, which serves the same
 * bytes to the web UI. Read it there rather than restating it here; the two
 * routes disagreeing about ownership is the defect that made it shared.
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
    if (!ownsImageHash(user.id, hash)) throw new ApiError(404, "not_found");

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
        // Same reasoning as `src/app/media/images/[hash]/route.ts`, which
        // states it at length: a sub-`MIN_IMAGE_SIZE` SVG is stored and
        // served verbatim, so these bytes can be an active document, and
        // `requireApiUser()`'s cookie fallback makes this URL just as
        // navigable from a browser as that one. A CSP closes the
        // direct-navigation vector without touching `<img>` rendering.
        "Content-Security-Policy": "default-src 'none'; sandbox",
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
