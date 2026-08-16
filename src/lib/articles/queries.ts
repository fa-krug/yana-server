import { and, asc, count, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";

import { currentUserId } from "@/lib/auth/session";
import { buildTree, type BlockNode } from "@/lib/blocks/tree";
import type { ListParams } from "@/lib/crud/params";
import { getDb } from "@/lib/db/client";
import {
  articleBlocks,
  articleInlineRuns,
  articles,
  feedTags,
  feeds,
  type Article,
  type Feed,
} from "@/lib/db/schema";

import { toFtsQuery } from "./search-query";

export type ArticleListRow = {
  id: number;
  name: string;
  date: Date;
  createdAt: Date;
  read: boolean;
  starred: boolean;
  author: string;
  feedId: number;
  feedName: string;
};

const SORTABLE: Record<string, AnySQLiteColumn> = {
  name: articles.name,
  date: articles.date,
  createdAt: articles.createdAt,
  read: articles.read,
  starred: articles.starred,
  feed: feeds.name,
};

/**
 * List articles owned by the current user.
 *
 * plainText is deliberately absent from the selected columns: it is the largest
 * column on the table and no list column shows it. Selecting it would multiply
 * the payload for nothing.
 */
export async function listArticles(
  params: ListParams,
): Promise<{ rows: ArticleListRow[]; total: number }> {
  const userId = await currentUserId();
  const db = getDb();

  const conditions: SQL[] = [eq(feeds.userId, userId)];

  // Full-text search through the `articles_fts` external-content FTS5 index
  // (see the `articles_fts` migration), not a LIKE scan: the previous
  // `LIKE '%term%'` over `plainText` -- the largest column on the table --
  // full-scanned once for the rows and again for the count().
  //
  // Behaviour note: FTS5 matches token prefixes, where LIKE matched mid-word.
  // `wind` finds `Windows`; `ndows` no longer does.
  const term = params.q.trim();
  const ftsQuery = toFtsQuery(term);
  if (ftsQuery) {
    conditions.push(
      sql`${articles.id} IN (SELECT rowid FROM articles_fts WHERE articles_fts MATCH ${ftsQuery})`,
    );
  }

  if (params.filters.feed) {
    const feedId = Number.parseInt(params.filters.feed, 10);
    if (!Number.isNaN(feedId)) {
      conditions.push(eq(articles.feedId, feedId));
    }
  }

  if (params.filters.read !== undefined && params.filters.read !== "") {
    conditions.push(eq(articles.read, params.filters.read === "true"));
  }

  if (params.filters.starred !== undefined && params.filters.starred !== "") {
    conditions.push(eq(articles.starred, params.filters.starred === "true"));
  }

  if (params.filters.tag) {
    const tagId = Number.parseInt(params.filters.tag, 10);
    if (!Number.isNaN(tagId)) {
      conditions.push(
        inArray(
          articles.feedId,
          db.select({ feedId: feedTags.feedId }).from(feedTags).where(eq(feedTags.tagId, tagId)),
        ),
      );
    }
  }

  const whereClause = and(...conditions);

  const totalRow = db
    .select({ value: count() })
    .from(articles)
    .innerJoin(feeds, eq(articles.feedId, feeds.id))
    .where(whereClause)
    .get();
  const total = totalRow?.value ?? 0;

  const orderCol = SORTABLE[params.sort] ?? articles.date;
  const orderFunc = params.dir === "asc" ? asc : desc;

  const rows = db
    .select({
      id: articles.id,
      name: articles.name,
      date: articles.date,
      createdAt: articles.createdAt,
      read: articles.read,
      starred: articles.starred,
      author: articles.author,
      feedId: articles.feedId,
      feedName: feeds.name,
    })
    .from(articles)
    .innerJoin(feeds, eq(articles.feedId, feeds.id))
    .where(whereClause)
    .orderBy(orderFunc(orderCol), desc(articles.id))
    .limit(params.pageSize)
    .offset((params.page - 1) * params.pageSize)
    .all();

  return { rows, total };
}

/**
 * Get a single article owned by the current user, including feed details.
 */
export async function getArticle(id: number): Promise<(Article & { feed: Feed }) | null> {
  const userId = await currentUserId();
  const db = getDb();

  const row = db
    .select({
      article: articles,
      feed: feeds,
    })
    .from(articles)
    .innerJoin(feeds, eq(articles.feedId, feeds.id))
    .where(and(eq(articles.id, id), eq(feeds.userId, userId)))
    .get();

  if (!row) return null;
  return { ...row.article, feed: row.feed };
}

/**
 * Fetch and build the block tree for an article owned by the current user.
 */
export async function getBlockTree(articleId: number): Promise<BlockNode[]> {
  const userId = await currentUserId();
  const db = getDb();

  // Verify ownership
  const owned = db
    .select({ id: articles.id })
    .from(articles)
    .innerJoin(feeds, eq(articles.feedId, feeds.id))
    .where(and(eq(articles.id, articleId), eq(feeds.userId, userId)))
    .get();

  if (!owned) return [];

  const blocks = db
    .select()
    .from(articleBlocks)
    .where(eq(articleBlocks.articleId, articleId))
    .all();

  if (blocks.length === 0) return [];

  const blockIds = blocks.map((b) => b.id);
  const runs = db
    .select()
    .from(articleInlineRuns)
    .where(inArray(articleInlineRuns.blockId, blockIds))
    .all();

  return buildTree(blocks, runs);
}
