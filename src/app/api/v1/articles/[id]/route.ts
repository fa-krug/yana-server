import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import { ApiError, apiErrorResponse, requireApiUser } from "@/lib/api/auth";
import { serializeArticleSummary } from "@/lib/api/serializers";
import { getDb, writeTransaction } from "@/lib/db/client";
import { articles, feeds } from "@/lib/db/schema";

const patchBody = z
  .object({ starred: z.boolean().optional(), read: z.boolean().optional() })
  .refine((body) => body.starred !== undefined || body.read !== undefined, {
    message: "Provide starred and/or read.",
  });

/**
 * The native client's star/read-toggle endpoint. Ownership is checked the
 * same way `content/route.ts` (Task 15) and `syncArticles()` (Task 13) scope
 * rows -- `articles.feedId IN (SELECT id FROM feeds WHERE userId = ?)` --
 * and a mismatch answers the same 404 as a nonexistent id, never a 403.
 *
 * The re-`SELECT` that builds the response only runs when the ownership-
 * scoped `UPDATE`'s `result.changes > 0` -- i.e. it actually matched a row
 * the caller owns. Re-selecting unconditionally after a 0-row `UPDATE` would
 * hand back another user's article on a request that changed nothing,
 * exactly the enumeration leak the 404-not-403 convention exists to prevent.
 */
export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const user = await requireApiUser(request);

    const { id } = await ctx.params;
    const articleId = Number(id);
    if (!Number.isInteger(articleId)) throw new ApiError(404, "not_found");

    const json = await request.json().catch(() => null);
    const parsed = patchBody.safeParse(json);
    if (!parsed.success) {
      throw new ApiError(400, "invalid_body", "Provide starred and/or read.");
    }

    const patch: { starred?: boolean; read?: boolean } = {};
    if (parsed.data.starred !== undefined) patch.starred = parsed.data.starred;
    if (parsed.data.read !== undefined) patch.read = parsed.data.read;

    const db = getDb();
    const userFeedIds = db.select({ id: feeds.id }).from(feeds).where(eq(feeds.userId, user.id));

    const updated = writeTransaction((tx) => {
      const result = tx
        .update(articles)
        .set(patch)
        .where(and(eq(articles.id, articleId), inArray(articles.feedId, userFeedIds)))
        .run();
      if (result.changes === 0) return null;
      return tx.select().from(articles).where(eq(articles.id, articleId)).get() ?? null;
    });

    if (!updated) throw new ApiError(404, "not_found");
    return Response.json(serializeArticleSummary(updated));
  } catch (error) {
    if (error instanceof ApiError) return apiErrorResponse(error);
    throw error;
  }
}
