import fs from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";

import { ownsImageHash } from "@/lib/aggregators/images/ownership";
import { mediaRoot } from "@/lib/avatar-storage";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { articleImages } from "@/lib/db/schema/articles";

const HASH_PATTERN = /^[0-9a-fA-F]{64}$/;

/**
 * `GET /media/images/<hash>` -- serves content-addressed article images to
 * the web UI. `src/components/articles/block-node.tsx` rewrites every stored
 * `yana-img://<hash>` ref -- an image block's `imageRef` and an embed's
 * `thumbnailRef` alike -- into this URL, so this route is how every article
 * image in the browser renders.
 *
 * **It authenticates *and* authorizes itself, because nothing above it does.**
 * A route handler has no layout above it, and `src/proxy.ts` only checks that
 * *a* session cookie exists. `requireUser()` is therefore the authentication,
 * and `ownsImageHash()` (`@/lib/aggregators/images/ownership.ts`) is the
 * authorization -- being signed in is not permission to read someone else's
 * article image. That second half is deliberately the *same function*
 * `GET /api/v1/images/<hash>` calls: the two routes serve identical bytes, and
 * until this one shared the check it did `requireUser()` and nothing else, so
 * any signed-in user who could read a hash out of a shared article's blocks
 * could read any other user's image. Read that module for the three reference
 * roots and their two hash encodings.
 *
 * **Every refusal is the same empty 404**, whatever the reason -- malformed
 * hash, unknown hash, a hash owned only by another user, or a row whose file
 * is missing. A caller can read hashes out of blocks they can see, so a
 * 200-vs-404 difference between "not yours" and "no such image" would be an
 * ownership oracle over other users' libraries. The one refusal that is *not*
 * a 404 is having no session at all: `requireUser()` redirects to `/login`,
 * the same answer the proxy already gives for this whole prefix, and uniform
 * across every hash, so it leaks nothing.
 *
 * Hash shape is validated before any filesystem or database access, so a
 * malformed value never costs a query and nothing downstream has to consider
 * a string that is not a hex digest.
 */
export async function GET(
  _request: Request,
  ctx: { params: Promise<{ hash: string }> },
): Promise<Response> {
  const user = await requireUser();

  const { hash } = await ctx.params;
  if (!HASH_PATTERN.test(hash)) {
    return refused();
  }
  const contentHash = hash.toLowerCase();

  if (!ownsImageHash(user.id, contentHash)) {
    return refused();
  }

  const row = getDb()
    .select()
    .from(articleImages)
    .where(eq(articleImages.contentHash, contentHash))
    .get();

  if (!row) {
    return refused();
  }

  const filePath = path.join(mediaRoot(), row.file);

  let bytes: Buffer;
  try {
    bytes = await fs.readFile(filePath);
  } catch {
    return refused();
  }

  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": row.contentType,
      "Content-Length": String(bytes.byteLength),
      "X-Content-Type-Options": "nosniff",
      // `private`, never `public`: the response is per-caller
      // access-controlled now, so `public` would license a shared cache or
      // intermediary to hand one user's article image to a caller this route
      // would have 404'd. The long lifetime stays, unlike the avatar route's
      // `no-store` -- that URL carries no version token, where this one *is*
      // the content hash and so cannot go stale.
      "Cache-Control": "private, max-age=31536000, immutable",
    },
  });
}

function refused(): Response {
  return new Response(null, { status: 404 });
}
