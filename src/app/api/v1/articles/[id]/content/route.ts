import { and, eq, inArray } from "drizzle-orm";
import { connection } from "next/server";

import { encodeDocument } from "@/lib/aggregators/blocks/schema";
import { readBlocks } from "@/lib/aggregators/blocks/storage";
import { ApiError, apiErrorResponse, requireApiUser } from "@/lib/api/auth";
import { getDb } from "@/lib/db/client";
import { articles, feeds } from "@/lib/db/schema";

/**
 * The native client's article-content endpoint: the block tree Task 16-17's
 * writers populate, encoded to the wire format `encodeDocument()` defines.
 * Ownership is checked the same way `syncArticles()` (Task 13) scopes rows --
 * `articles.feedId IN (SELECT id FROM feeds WHERE userId = ?)` -- and a
 * mismatch answers the same 404 as a nonexistent id, never a 403, so this
 * route cannot be used to enumerate other users' article ids.
 *
 * `await connection()` must be the literal first statement, ahead of
 * `requireApiUser()` -- see the `connection()` bullet in the root CLAUDE.md:
 * this route has no other Dynamic API call in its path (no cookie/header
 * read is guaranteed -- a Bearer-token caller never touches `next/headers`),
 * so nothing else would opt it out of prerendering.
 */
export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  await connection();

  try {
    const user = await requireApiUser(request);

    const { id } = await ctx.params;
    const articleId = Number(id);
    if (!Number.isInteger(articleId)) throw new ApiError(404, "not_found");

    const db = getDb();
    const userFeedIds = db.select({ id: feeds.id }).from(feeds).where(eq(feeds.userId, user.id));
    const article = db
      .select({ id: articles.id })
      .from(articles)
      .where(and(eq(articles.id, articleId), inArray(articles.feedId, userFeedIds)))
      .get();
    if (!article) throw new ApiError(404, "not_found");

    const blocks = await readBlocks(articleId);
    return Response.json(encodeDocument(blocks));
  } catch (error) {
    if (error instanceof ApiError) return apiErrorResponse(error);
    throw error;
  }
}
