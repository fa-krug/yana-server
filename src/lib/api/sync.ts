import { and, asc, eq, gt, inArray, or, type SQL } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import { articleTombstones, articles, feeds } from "@/lib/db/schema";
import { RETENTION_TOMBSTONE_DAYS } from "@/lib/jobs/handlers/retention";
import { serializeArticleSummary, type ArticleSummaryWire } from "./serializers";

/**
 * Three independently-tracked positions, one per delta stream. Each is a
 * `[epochSeconds, id]` pair: the timestamp column the stream orders by, with
 * the row id as a tie-breaker for rows sharing a timestamp (two articles can
 * share a `createdAt` second, and ordering by timestamp alone would then
 * either skip or repeat one across pages).
 *
 * The three positions are independent because the three things they track
 * are independent: an article can be created, updated and (later) deleted on
 * different schedules, and a client paging through a large `new` backlog
 * must not stall `updated`/`removed` progress, or vice versa.
 */
export interface SyncCursor {
  newPos: [number, number];
  updatedPos: [number, number];
  removedPos: [number, number];
}

export const ZERO_CURSOR: SyncCursor = { newPos: [0, 0], updatedPos: [0, 0], removedPos: [0, 0] };

function isPair(value: unknown): value is [number, number] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === "number" &&
    typeof value[1] === "number"
  );
}

function isSyncCursor(value: unknown): value is SyncCursor {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return isPair(v.newPos) && isPair(v.updatedPos) && isPair(v.removedPos);
}

export function encodeCursor(cursor: SyncCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

/** Never throws -- an unparseable or malformed cursor is treated as "start over," not a client error. */
export function decodeCursor(raw: string | null | undefined): SyncCursor {
  if (!raw) return ZERO_CURSOR;
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    return isSyncCursor(parsed) ? parsed : ZERO_CURSOR;
  } catch {
    return ZERO_CURSOR;
  }
}

export interface SyncPage {
  new: ArticleSummaryWire[];
  updated: ArticleSummaryWire[];
  removed: number[];
  nextCursor: string;
}

export type SyncResult = SyncPage | { resyncRequired: true };

function secondsOf(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

function fromSeconds(seconds: number): Date {
  return new Date(seconds * 1000);
}

/**
 * `(timestampCol, idCol) > (pos[0], pos[1])`, the tuple comparison a cursor
 * position needs: strictly after the timestamp, or equal to it and strictly
 * after the id. A plain `gt(timestampCol, ...)` alone would silently skip
 * every row after the first when two rows share a timestamp second.
 *
 * KNOWN LIMITATION, inherited from the schema rather than introduced here:
 * `createdAt`/`updatedAt` are whole-second SQLite integers (drizzle-orm's
 * `timestamp` mode truncates via `Math.floor(unix / 1000)`), and the
 * tie-break here is a row's own primary key. For the `updated` stream that
 * combination has a blind spot `new` doesn't: a row's id is stable across
 * every write to it, so if that *same* row is written to twice within the
 * *same* wall-clock second, the second write is indistinguishable from
 * "already accounted for" -- `updatedAt` didn't change (still the same
 * second) and `id` can't be greater than itself. The write is not merely
 * delayed; it stays invisible until a later write to that row lands in a
 * different second. This is unreachable for `new` (a row's `createdAt` --
 * and thus its position in that stream -- is set once, at insert, and never
 * revisited) and unreachable for `removed` (a tombstone is inserted once,
 * never updated). Closing it for `updated` needs either sub-second timestamp
 * precision or a per-row revision counter, neither of which exists on
 * `articles` today -- out of scope for this module to add unilaterally.
 */
function afterPos(
  timestampCol: Parameters<typeof gt>[0],
  idCol: Parameters<typeof gt>[0],
  pos: [number, number],
): SQL {
  return or(
    gt(timestampCol, fromSeconds(pos[0])),
    and(eq(timestampCol, fromSeconds(pos[0])), gt(idCol, pos[1])),
  )!;
}

/**
 * True when some deletion between the client's cursor and now has already
 * been pruned by the retention job's tombstone cleanup (see
 * `RETENTION_TOMBSTONE_DAYS` in `src/lib/jobs/handlers/retention.ts`) -- i.e.
 * a delta from here could omit a `removed` id the client never learned
 * about. Tombstone rows are themselves eventually pruned by that job, so the
 * oldest *surviving* tombstone is the earliest point any client can still be
 * proven caught-up from: if that survivor is newer than the client's
 * `removedPos`, something between the two may have been pruned without a
 * trace, and there is no way to tell -- so the client must resync from
 * scratch rather than trust a `removed` list that might have a gap in it.
 *
 * **The comparison is against the prune horizon itself, not only against a
 * surviving row.** A surviving oldest tombstone is evidence the horizon
 * check alone would miss nothing new, but its *absence* is not evidence of
 * the opposite: if the retention job has pruned every tombstone (none
 * younger than `RETENTION_TOMBSTONE_DAYS`), there is no surviving row to
 * compare against at all, and a cursor older than that horizon must still be
 * told to resync -- it may have missed deletions that happened and were
 * later pruned, with nothing left to prove it either way. Checking the
 * horizon first, before any row lookup, is what keeps the zero-tombstones
 * case from silently defaulting to "not expired."
 *
 * `removedPos === ZERO_CURSOR.removedPos` (`[0, 0]`) is excluded from this
 * check on purpose: it does not mean "caught up as of the epoch," it means
 * "this stream has never consumed a single tombstone." There is nothing to
 * have lost track of yet, and telling a client that has never synced to go
 * resync -- i.e. to do exactly the full fetch it is already about to do --
 * would just be a wasted round trip with no data in it. Every real
 * `removedPos` a client can hold came from a `deletedAt`/`id` pair of an
 * actual tombstone row (ids are autoincrement from 1), so `[0, 0]` can never
 * collide with one.
 */
function cursorExpired(userId: string, cursor: SyncCursor): boolean {
  if (cursor.removedPos[0] === 0 && cursor.removedPos[1] === 0) return false;

  const pruneHorizon = new Date(Date.now() - RETENTION_TOMBSTONE_DAYS * 24 * 60 * 60_000);
  if (secondsOf(pruneHorizon) > cursor.removedPos[0]) return true;

  const oldest = getDb()
    .select({ deletedAt: articleTombstones.deletedAt })
    .from(articleTombstones)
    .where(eq(articleTombstones.userId, userId))
    .orderBy(asc(articleTombstones.deletedAt), asc(articleTombstones.id))
    .limit(1)
    .get();

  if (!oldest) return false;
  return secondsOf(oldest.deletedAt) > cursor.removedPos[0];
}

/**
 * Exactly the columns `serializeArticleSummary` reads, and no more. A bare
 * `db.select()` here would additionally pull `rawContent` -- a whole fetched
 * HTML page -- and `plainText` for every row in both streams, only for the
 * serializer to discard them. `listArticles` in `@/lib/articles/queries`
 * avoids the same trap for the same reason.
 */
const SUMMARY_COLUMNS = {
  id: articles.id,
  feedId: articles.feedId,
  name: articles.name,
  identifier: articles.identifier,
  date: articles.date,
  author: articles.author,
  icon: articles.icon,
  read: articles.read,
  starred: articles.starred,
  createdAt: articles.createdAt,
  updatedAt: articles.updatedAt,
} as const;

export function syncArticles(userId: string, cursor: SyncCursor, limit: number): SyncResult {
  if (cursorExpired(userId, cursor)) return { resyncRequired: true };

  const db = getDb();
  // A subquery, not a materialized array: a user with zero feeds makes this
  // resolve to zero rows, which `inArray` turns into ordinary (never-true)
  // SQL rather than the invalid-empty-array case a literal `[]` would be.
  const userFeedIds = db.select({ id: feeds.id }).from(feeds).where(eq(feeds.userId, userId));

  const newRows = db
    .select(SUMMARY_COLUMNS)
    .from(articles)
    .where(
      and(
        inArray(articles.feedId, userFeedIds),
        afterPos(articles.createdAt, articles.id, cursor.newPos),
      ),
    )
    .orderBy(asc(articles.createdAt), asc(articles.id))
    .limit(limit)
    .all();

  const newIds = new Set(newRows.map((row) => row.id));

  // An article inserted since the client's last sync has both a fresh
  // createdAt and a fresh updatedAt, so it would otherwise match this query
  // too. It must not be duplicated into `updated`'s *output* -- but the
  // exclusion is applied here in JS, after fetching, rather than as a
  // `notInArray` in the SQL `WHERE`. Applying it in SQL would make the fetch
  // itself skip those rows, and then `nextUpdatedPos` -- derived from the
  // last *fetched* row -- would never advance past them. The next sync call
  // would then re-scan from that stale position and find the very same rows
  // matching `updatedAt > cursor.updatedPos` again, now with nothing left to
  // exclude them, surfacing a false `updated` entry for something already
  // fully delivered via `new`. Filtering post-fetch keeps the fetch --and
  // so the cursor advancement-- correct regardless of overlap with `new`.
  const updatedRowsFetched = db
    .select(SUMMARY_COLUMNS)
    .from(articles)
    .where(
      and(
        inArray(articles.feedId, userFeedIds),
        afterPos(articles.updatedAt, articles.id, cursor.updatedPos),
      ),
    )
    .orderBy(asc(articles.updatedAt), asc(articles.id))
    .limit(limit)
    .all();

  const updatedRows = updatedRowsFetched.filter((row) => !newIds.has(row.id));

  const removedRows = db
    .select()
    .from(articleTombstones)
    .where(
      and(
        eq(articleTombstones.userId, userId),
        afterPos(articleTombstones.deletedAt, articleTombstones.id, cursor.removedPos),
      ),
    )
    .orderBy(asc(articleTombstones.deletedAt), asc(articleTombstones.id))
    .limit(limit)
    .all();

  const nextNewPos: [number, number] =
    newRows.length > 0 ? [secondsOf(newRows.at(-1)!.createdAt), newRows.at(-1)!.id] : cursor.newPos;
  const nextUpdatedPos: [number, number] =
    updatedRowsFetched.length > 0
      ? [secondsOf(updatedRowsFetched.at(-1)!.updatedAt), updatedRowsFetched.at(-1)!.id]
      : cursor.updatedPos;
  const nextRemovedPos: [number, number] =
    removedRows.length > 0
      ? [secondsOf(removedRows.at(-1)!.deletedAt), removedRows.at(-1)!.id]
      : cursor.removedPos;

  return {
    new: newRows.map(serializeArticleSummary),
    updated: updatedRows.map(serializeArticleSummary),
    removed: removedRows.map((row) => row.articleId),
    nextCursor: encodeCursor({
      newPos: nextNewPos,
      updatedPos: nextUpdatedPos,
      removedPos: nextRemovedPos,
    }),
  };
}
