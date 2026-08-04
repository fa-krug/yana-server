import { eq, inArray } from "drizzle-orm";
import { connection } from "next/server";

import { ApiError, apiErrorResponse, requireApiUser } from "@/lib/api/auth";
import { serializeFeed } from "@/lib/api/serializers";
import { getDb } from "@/lib/db/client";
import { feedTags, feeds } from "@/lib/db/schema";

/**
 * The native client's (and web UI's) feed list, scoped to the caller's own
 * feeds -- each carrying its `tagIds` so the client can render feed/tag
 * associations without a second round trip per feed.
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
    const db = getDb();
    const feedRows = db.select().from(feeds).where(eq(feeds.userId, user.id)).all();

    if (feedRows.length === 0) return Response.json({ feeds: [] });

    // `inArray()` on an empty array is invalid SQL (`IN ()`), but `feedRows`
    // is non-empty on this path, so `feedIds` always has at least one entry.
    const feedIds = feedRows.map((feed) => feed.id);
    const tagRows = db
      .select({ feedId: feedTags.feedId, tagId: feedTags.tagId })
      .from(feedTags)
      .where(inArray(feedTags.feedId, feedIds))
      .all();

    const tagIdsByFeed = new Map<number, number[]>();
    for (const row of tagRows) {
      const list = tagIdsByFeed.get(row.feedId) ?? [];
      list.push(row.tagId);
      tagIdsByFeed.set(row.feedId, list);
    }

    return Response.json({
      feeds: feedRows.map((feed) => serializeFeed(feed, tagIdsByFeed.get(feed.id) ?? [])),
    });
  } catch (error) {
    if (error instanceof ApiError) return apiErrorResponse(error);
    throw error;
  }
}
