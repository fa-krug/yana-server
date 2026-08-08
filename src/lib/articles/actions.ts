"use server";

import { and, eq, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { currentUserId } from "@/lib/auth/session";
import { getDb, writeTransaction } from "@/lib/db/client";
import { articles, feeds } from "@/lib/db/schema";
import { enqueueRun, PRIORITY_IMMEDIATE } from "@/lib/jobs/queue";

const updateArticleSchema = z.object({
  name: z.string().min(1, "Name is required").optional(),
  feedId: z.number().int().positive().optional(),
  date: z
    .union([z.date(), z.string(), z.number()])
    .transform((val) => new Date(val))
    .optional(),
});

export type UpdateArticleInput = z.input<typeof updateArticleSchema>;

export async function updateArticle(
  id: number,
  input: unknown,
): Promise<{ ok: boolean; error?: string; field?: string }> {
  try {
    const userId = await currentUserId();
    const parsed = updateArticleSchema.safeParse(input);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return {
        ok: false,
        field: issue?.path[0]?.toString(),
        error: issue?.message || "Invalid input",
      };
    }

    const { name, feedId, date } = parsed.data;

    const db = getDb();
    const existing = db
      .select({ id: articles.id, feedId: articles.feedId })
      .from(articles)
      .innerJoin(feeds, eq(articles.feedId, feeds.id))
      .where(and(eq(articles.id, id), eq(feeds.userId, userId)))
      .get();

    if (!existing) {
      return { ok: false, error: "Article not found" };
    }

    if (feedId !== undefined && feedId !== existing.feedId) {
      const targetFeed = db
        .select({ id: feeds.id })
        .from(feeds)
        .where(and(eq(feeds.id, feedId), eq(feeds.userId, userId)))
        .get();

      if (!targetFeed) {
        return { ok: false, field: "feedId", error: "Target feed not found or not owned" };
      }
    }

    return writeTransaction((tx) => {
      tx.update(articles)
        .set({
          ...(name !== undefined && { name }),
          ...(feedId !== undefined && { feedId }),
          ...(date !== undefined && { date }),
        })
        .where(eq(articles.id, id))
        .run();

      revalidatePath("/articles");
      revalidatePath(`/articles/${id}`);
      return { ok: true };
    });
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function deleteArticles(ids: number[]): Promise<{ ok: boolean; deleted: number }> {
  if (ids.length === 0) return { ok: true, deleted: 0 };

  const userId = await currentUserId();
  const db = getDb();

  const userFeedIds = db.select({ id: feeds.id }).from(feeds).where(eq(feeds.userId, userId));

  return writeTransaction((tx) => {
    const result = tx
      .delete(articles)
      .where(and(inArray(articles.id, ids), inArray(articles.feedId, userFeedIds)))
      .run();

    revalidatePath("/articles");
    return { ok: true, deleted: result.changes };
  });
}

export async function setRead(
  ids: number[],
  read: boolean,
): Promise<{ ok: boolean; updated: number }> {
  if (ids.length === 0) return { ok: true, updated: 0 };

  const userId = await currentUserId();
  const db = getDb();

  const userFeedIds = db.select({ id: feeds.id }).from(feeds).where(eq(feeds.userId, userId));

  return writeTransaction((tx) => {
    const result = tx
      .update(articles)
      .set({ read })
      .where(and(inArray(articles.id, ids), inArray(articles.feedId, userFeedIds)))
      .run();

    revalidatePath("/articles");
    return { ok: true, updated: result.changes };
  });
}

export async function setStarred(
  ids: number[],
  starred: boolean,
): Promise<{ ok: boolean; updated: number }> {
  if (ids.length === 0) return { ok: true, updated: 0 };

  const userId = await currentUserId();
  const db = getDb();

  const userFeedIds = db.select({ id: feeds.id }).from(feeds).where(eq(feeds.userId, userId));

  return writeTransaction((tx) => {
    const result = tx
      .update(articles)
      .set({ starred })
      .where(and(inArray(articles.id, ids), inArray(articles.feedId, userFeedIds)))
      .run();

    revalidatePath("/articles");
    return { ok: true, updated: result.changes };
  });
}

export async function reloadArticles(
  ids: number[],
): Promise<{ ok: boolean; enqueued: number; runId: number }> {
  const userId = await currentUserId();
  const db = getDb();

  const userFeedIds = db.select({ id: feeds.id }).from(feeds).where(eq(feeds.userId, userId));

  const validArticles = db
    .select({ id: articles.id })
    .from(articles)
    .where(and(inArray(articles.id, ids), inArray(articles.feedId, userFeedIds)))
    .all();

  const runId = enqueueRun(
    userId,
    "article.reload",
    validArticles.map((a) => ({ articleId: a.id })),
    PRIORITY_IMMEDIATE,
  );

  return { ok: true, enqueued: validArticles.length, runId };
}
