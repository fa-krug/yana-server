"use server";

import { and, eq, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import type { NamespaceKey } from "@/i18n/next-intl";
import { currentUserId } from "@/lib/auth/session";
import { getDb, writeTransaction } from "@/lib/db/client";
import { articles, articleTombstones, feeds } from "@/lib/db/schema";
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

/**
 * A key under the `articles` catalog namespace -- never zod's own message,
 * never a raw driver string. Typed at its source (see the `errorKey`
 * convention in CLAUDE.md and `src/lib/settings/actions.ts`) so a key neither
 * catalog defines fails `npm run typecheck` rather than rendering a raw key
 * path into a toast. `updateArticle()` has exactly one case that needs it --
 * see the `feedId` guard below -- so it is declared inline rather than
 * pulled into a `result.ts` binding of its own; `article-form.tsx` already
 * calls this action through `attemptCall()`, not a namespaced `attempt()`,
 * for the same "one case doesn't earn a binding" reason.
 */
export type UpdateArticleErrorKey = NamespaceKey<"articles">;

export async function updateArticle(
  id: number,
  input: unknown,
): Promise<{ ok: boolean; error?: string; field?: string; errorKey?: UpdateArticleErrorKey }> {
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

    // `feedId` is half the key the aggregate handler looks a row up by --
    // `(feedId, identifier)`, see `aggregate.ts` -- so letting it change here
    // is not an ordinary edit: move this article to another feed and the
    // original feed's next run finds no row for its identifier and inserts a
    // fresh duplicate. There is no safe way to let the move stand without
    // also teaching the original feed the row is gone (a tombstone), and a
    // tombstone here would make a deliberate re-file indistinguishable from a
    // deletion in the native client's sync `removed` stream. Forbidding the
    // move is simpler and is what the article form's feed control now
    // reflects: it renders disabled with an explanation rather than a control
    // that always errors.
    if (feedId !== undefined && feedId !== existing.feedId) {
      return { ok: false, field: "feedId", errorKey: "feedChangeForbidden" };
    }

    return writeTransaction((tx) => {
      tx.update(articles)
        .set({
          ...(name !== undefined && { name }),
          ...(date !== undefined && { date }),
          // `articles.contentHash` is deliberately left alone, so this edit
          // stands. It used to be nulled because `name` and `date` are
          // fingerprint inputs and the stored hash therefore no longer
          // described the row -- true when the hash described the stored
          // bytes. It is now taken over the article as *fetched from source*
          // (see `rawArticleContentHash()`), which a local edit does not
          // change, so the next aggregation run matches, skips, and the edit
          // survives; a genuine upstream change still moves the fingerprint
          // and replaces it. The old behaviour made every manual edit
          // provisional until the next cycle silently reverted it. Same ruling
          // as a successful `article.reload`, and for the same reason. `feedId`
          // is never written here at all -- see the guard above.
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
    // Tombstones must be written for exactly the rows that will actually be
    // deleted, scoped by the same ownership condition as the delete below --
    // never by `ids` directly, which may name articles the caller does not
    // own. See articleTombstones' doc comment in schema/articles.ts: every
    // hard-delete path on `articles` must insert one of these first, in the
    // same transaction, or a client that already synced the row never learns
    // it is gone.
    const doomed = tx
      .select({ id: articles.id })
      .from(articles)
      .where(and(inArray(articles.id, ids), inArray(articles.feedId, userFeedIds)))
      .all();

    if (doomed.length === 0) {
      revalidatePath("/articles");
      return { ok: true, deleted: 0 };
    }

    const doomedIds = doomed.map((a) => a.id);

    tx.insert(articleTombstones)
      .values(doomedIds.map((articleId) => ({ articleId, userId })))
      .run();

    tx.delete(articles).where(inArray(articles.id, doomedIds)).run();

    revalidatePath("/articles");
    return { ok: true, deleted: doomedIds.length };
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
