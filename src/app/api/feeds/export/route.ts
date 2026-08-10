import { and, eq, inArray } from "drizzle-orm";

import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { feeds, feedTags, tags } from "@/lib/db/schema";
import { encodeOpml, type OpmlExportFeed } from "@/lib/feeds/opml";

/**
 * `GET /api/feeds/export` — an OPML download of the caller's own feeds.
 *
 * A route handler, not a server action: actions in this codebase only ever
 * return JSON, and a file download needs a real HTTP response carrying
 * `Content-Disposition`. Authenticates itself with `requireUser()`, the same
 * as `src/app/media/avatars/[userId]/route.ts` — nothing above a route
 * handler does.
 *
 * Not under `/api/v1`: that prefix is the Bearer-token native-client API
 * (`requireApiUser()`). This is a cookie-session, browser-only feature.
 *
 * `?ids=1,2,3` narrows the export to those feeds, but the `userId` filter is
 * always applied on top of it — an id belonging to another user is silently
 * excluded rather than exported, the same "compare, don't trust the id"
 * rule the avatar route follows.
 */
export async function GET(request: Request): Promise<Response> {
  const user = await requireUser();

  const url = new URL(request.url);
  const idsParam = url.searchParams.get("ids");
  const ids = idsParam
    ? idsParam
        .split(",")
        .map((id) => Number(id))
        .filter((id) => Number.isInteger(id))
    : undefined;

  const db = getDb();
  const conditions = [eq(feeds.userId, user.id)];
  if (ids && ids.length > 0) {
    conditions.push(inArray(feeds.id, ids));
  }

  const rows = db
    .select()
    .from(feeds)
    .where(and(...conditions))
    .all();

  const exportFeeds: OpmlExportFeed[] = rows.map((row) => {
    const feedTagRows = db
      .select({ name: tags.name })
      .from(feedTags)
      .innerJoin(tags, eq(feedTags.tagId, tags.id))
      .where(eq(feedTags.feedId, row.id))
      .all();

    return {
      name: row.name,
      aggregator: row.aggregator,
      identifier: row.identifier,
      enabled: row.enabled,
      dailyLimit: row.dailyLimit,
      updateIntervalMinutes: row.updateIntervalMinutes,
      concurrency: row.concurrency,
      maxArticleAgeDays: row.maxArticleAgeDays,
      options: row.options,
      tags: feedTagRows.map((t) => t.name),
    };
  });

  return new Response(encodeOpml(exportFeeds), {
    headers: {
      "Content-Type": "text/x-opml+xml; charset=utf-8",
      "Content-Disposition": 'attachment; filename="yana-feeds.opml"',
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
