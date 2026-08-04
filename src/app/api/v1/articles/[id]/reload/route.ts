import { and, eq, inArray } from "drizzle-orm";

import { ApiError, apiErrorResponse, requireApiUser } from "@/lib/api/auth";
import { getDb, writeTransaction } from "@/lib/db/client";
import { articles, feeds, jobs } from "@/lib/db/schema";

/**
 * The native client's single-article reload endpoint -- the same
 * `article.reload` job `reloadArticles()` (`src/lib/articles/actions.ts`)
 * enqueues for the web UI's bulk action, here for one article via the API.
 * Ownership is checked the same way every other `/api/v1/articles/**` route
 * scopes rows -- `articles.feedId IN (SELECT id FROM feeds WHERE userId = ?)`
 * -- and a mismatch answers the same 404 as a nonexistent id, never a 403, so
 * this route cannot be used to enumerate other users' article ids.
 *
 * The ownership check and the `INSERT` happen inside one `writeTransaction()`
 * so a mismatch can never enqueue a job -- there is no window where the
 * `SELECT` passes and the row is deleted or reassigned before the `INSERT`.
 */
export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const user = await requireApiUser(request);

    const { id } = await ctx.params;
    const articleId = Number(id);
    if (!Number.isInteger(articleId)) throw new ApiError(404, "not_found");

    const db = getDb();
    const userFeedIds = db.select({ id: feeds.id }).from(feeds).where(eq(feeds.userId, user.id));

    const jobId = writeTransaction((tx) => {
      const article = tx
        .select({ id: articles.id })
        .from(articles)
        .where(and(eq(articles.id, articleId), inArray(articles.feedId, userFeedIds)))
        .get();
      if (!article) return null;

      const inserted = tx
        .insert(jobs)
        .values({ kind: "article.reload", payload: { articleId } })
        .returning({ id: jobs.id })
        .get();
      return inserted.id;
    });

    if (jobId === null) throw new ApiError(404, "not_found");
    return Response.json({ jobId }, { status: 202 });
  } catch (error) {
    if (error instanceof ApiError) return apiErrorResponse(error);
    throw error;
  }
}
