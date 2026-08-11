import { and, eq, inArray } from "drizzle-orm";
import { connection } from "next/server";
import { z } from "zod";

import { ApiError, apiErrorResponse, requireApiUser } from "@/lib/api/auth";
import { serializeReadingPosition } from "@/lib/api/serializers";
import { getDb, writeTransaction } from "@/lib/db/client";
import { articles, feeds, userSettings } from "@/lib/db/schema";

/**
 * The native client's cross-device "current article" pointer -- one row per
 * user on `user_settings` (`readingPositionArticleId`/`readingPositionUpdatedAt`,
 * see the schema comment), not a dedicated table: it is exactly the shape of
 * every other per-user preference already living there (`activeAiProvider`,
 * `theme`, ...), and every user is already guaranteed exactly one row.
 *
 * `await connection()` must be the literal first statement, ahead of
 * `requireApiUser()` -- see the `connection()` bullet in the root CLAUDE.md:
 * this route has no other Dynamic API call in its path (no cookie/header
 * read is guaranteed -- a Bearer-token caller never touches `next/headers`),
 * so nothing else would opt it out of prerendering.
 */
export async function GET(request: Request): Promise<Response> {
  await connection();

  try {
    const user = await requireApiUser(request);

    const settings = getDb()
      .select({
        readingPositionArticleId: userSettings.readingPositionArticleId,
        readingPositionUpdatedAt: userSettings.readingPositionUpdatedAt,
      })
      .from(userSettings)
      .where(eq(userSettings.userId, user.id))
      .get();
    if (!settings) {
      // A provisioning bug, never expected for a real account -- propagates
      // past this route's ApiError-only catch to Next's default 500. Same
      // shape as `POST /api/v1/ai/prompt`'s equivalent check.
      throw new Error(`no user_settings row for user "${user.id}"`);
    }

    return Response.json(serializeReadingPosition(settings));
  } catch (error) {
    if (error instanceof ApiError) return apiErrorResponse(error);
    throw error;
  }
}

const patchBody = z.object({ articleId: z.number().int() });

/**
 * Sets the pointer to `articleId`, stamping `readingPositionUpdatedAt` with
 * the server's own clock -- last-writer-wins is exactly what both the server
 * and the native client already assume for concurrent writes from two
 * devices, so no version check is needed here.
 *
 * Ownership is checked the same way `PATCH /api/v1/articles/[id]` scopes rows
 * -- `articles.feedId IN (SELECT id FROM feeds WHERE userId = ?)` -- and an
 * id that doesn't resolve to a row the caller owns answers the same
 * `not_found` as one that doesn't exist at all, never a 403.
 */
export async function PATCH(request: Request): Promise<Response> {
  try {
    const user = await requireApiUser(request);

    const json = await request.json().catch(() => null);
    const parsed = patchBody.safeParse(json);
    if (!parsed.success) {
      throw new ApiError(400, "invalid_body", "articleId is required.");
    }
    const { articleId } = parsed.data;

    const db = getDb();
    const userFeedIds = db.select({ id: feeds.id }).from(feeds).where(eq(feeds.userId, user.id));
    const owned = db
      .select({ id: articles.id })
      .from(articles)
      .where(and(eq(articles.id, articleId), inArray(articles.feedId, userFeedIds)))
      .get();
    if (!owned) throw new ApiError(404, "not_found");

    const updated = writeTransaction((tx) => {
      const result = tx
        .update(userSettings)
        .set({ readingPositionArticleId: articleId, readingPositionUpdatedAt: new Date() })
        .where(eq(userSettings.userId, user.id))
        .run();
      if (result.changes === 0) return null;
      return tx
        .select({
          readingPositionArticleId: userSettings.readingPositionArticleId,
          readingPositionUpdatedAt: userSettings.readingPositionUpdatedAt,
        })
        .from(userSettings)
        .where(eq(userSettings.userId, user.id))
        .get();
    });

    if (!updated) {
      // Same provisioning-bug case as GET, reached here instead because the
      // ownership check above already proved `articleId` is real -- so a
      // 0-row UPDATE can only mean the caller's own settings row is missing.
      throw new Error(`no user_settings row for user "${user.id}"`);
    }

    return Response.json(serializeReadingPosition(updated));
  } catch (error) {
    if (error instanceof ApiError) return apiErrorResponse(error);
    throw error;
  }
}
