"use server";

import { and, eq, inArray, count, desc, asc, like } from "drizzle-orm";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import { revalidatePath } from "next/cache";

import { currentUserId } from "@/lib/auth/session";
import { getDb, writeTransaction } from "@/lib/db/client";
import { feeds, feedTags, tags, jobs, articles } from "@/lib/db/schema";
import { getSettings } from "@/lib/settings/queries";
import type { ListParams } from "@/lib/crud/params";
import {
  AGGREGATOR_SPECS,
  schemaFor,
  stripUnavailable,
  type Capabilities,
} from "@/lib/aggregators/registry";
import { providerByKey } from "@/lib/ai/providers";

// Helper to determine active AI provider
function activeProvider(settings: Record<string, unknown>): string {
  const provider = providerByKey(settings.activeAiProvider as string);
  if (!provider) return "";
  const enabledCol = `${provider.key}Enabled` as keyof typeof settings;
  return settings[enabledCol] ? provider.key : "";
}

export async function capabilitiesFor(): Promise<Capabilities> {
  const settings = await getSettings();
  return {
    youtube: settings.youtubeEnabled,
    reddit: settings.redditEnabled,
    ai: !!activeProvider(settings),
  };
}

export async function getFeed(id: number) {
  const userId = await currentUserId();
  const db = getDb();

  const feed = db
    .select()
    .from(feeds)
    .where(and(eq(feeds.id, id), eq(feeds.userId, userId)))
    .get();
  if (!feed) return null;

  const attachedTags = db
    .select({
      id: tags.id,
      name: tags.name,
      userId: tags.userId,
      createdAt: tags.createdAt,
      updatedAt: tags.updatedAt,
    })
    .from(feedTags)
    .innerJoin(tags, eq(feedTags.tagId, tags.id))
    .where(eq(feedTags.feedId, id))
    .all();

  return { ...feed, tags: attachedTags };
}

export async function listFeeds(params: ListParams) {
  const userId = await currentUserId();
  const db = getDb();

  const conditions = [eq(feeds.userId, userId)];
  if (params.q) {
    conditions.push(like(feeds.name, `%${params.q}%`));
  }
  if (params.filters.aggregator) {
    conditions.push(eq(feeds.aggregator, params.filters.aggregator));
  }
  if (params.filters.enabled !== undefined) {
    conditions.push(eq(feeds.enabled, params.filters.enabled === "true"));
  }

  if (params.filters.tag) {
    conditions.push(
      inArray(
        feeds.id,
        db
          .select({ id: feedTags.feedId })
          .from(feedTags)
          .where(eq(feedTags.tagId, Number(params.filters.tag))),
      ),
    );
  }

  const whereClause = and(...conditions);

  const totalRow = db.select({ value: count() }).from(feeds).where(whereClause).get();
  const total = totalRow?.value ?? 0;

  let orderCol: AnySQLiteColumn = feeds.name;
  if (params.sort === "createdAt") orderCol = feeds.createdAt;
  else if (params.sort === "aggregator") orderCol = feeds.aggregator;

  const orderFunc = params.dir === "desc" ? desc : asc;

  const rows = db
    .select()
    .from(feeds)
    .where(whereClause)
    .orderBy(orderFunc(orderCol))
    .limit(params.pageSize)
    .offset((params.page - 1) * params.pageSize)
    .all();

  const resultRows = [];
  for (const row of rows) {
    const attachedTags = db
      .select({
        id: tags.id,
        name: tags.name,
        userId: tags.userId,
        createdAt: tags.createdAt,
        updatedAt: tags.updatedAt,
      })
      .from(feedTags)
      .innerJoin(tags, eq(feedTags.tagId, tags.id))
      .where(eq(feedTags.feedId, row.id))
      .all();

    const articleCountRow = db
      .select({ value: count() })
      .from(articles)
      .where(eq(articles.feedId, row.id))
      .get();

    resultRows.push({ ...row, tags: attachedTags, articleCount: articleCountRow?.value ?? 0 });
  }

  return { rows: resultRows, total };
}

type FeedInput = {
  name?: string;
  aggregator?: string;
  identifier?: string;
  options?: Record<string, unknown>;
  tagIds?: number[];
  enabled?: boolean;
};

export async function createFeed(
  input: FeedInput,
): Promise<{ ok: boolean; error?: string; field?: string; id?: number }> {
  try {
    const name = input?.name;
    const aggregator = input?.aggregator;
    const identifier = input?.identifier || "";
    const options = input?.options || {};
    const tagIds = input?.tagIds || [];

    if (!name) return { ok: false, field: "name", error: "Name is required" };
    if (!aggregator) return { ok: false, field: "aggregator", error: "Aggregator is required" };

    const spec = AGGREGATOR_SPECS[aggregator as keyof typeof AGGREGATOR_SPECS];
    if (!spec) return { ok: false, error: "Invalid aggregator" };

    if (spec.identifierRequired && !identifier) {
      return { ok: false, field: "identifier", error: "Identifier is required" };
    }

    const optionsParsed = schemaFor(spec.key).safeParse(options);
    if (!optionsParsed.success) {
      return { ok: false, error: "Invalid options" };
    }

    const capabilities = await capabilitiesFor();
    const cleanedOptions = stripUnavailable(
      spec.key,
      optionsParsed.data as Record<string, unknown>,
      capabilities,
    );

    const userId = await currentUserId();

    return writeTransaction((tx) => {
      if (tagIds.length > 0) {
        const validTags = tx
          .select({ id: tags.id })
          .from(tags)
          .where(and(inArray(tags.id, tagIds), eq(tags.userId, userId)))
          .all();
        if (validTags.length !== tagIds.length) {
          return { ok: false, error: "Invalid tags" };
        }
      }

      const feed = tx
        .insert(feeds)
        .values({
          name: name as string,
          aggregator: spec.key,
          identifier,
          options: cleanedOptions,
          userId,
        })
        .returning({ id: feeds.id })
        .get();

      if (tagIds.length > 0) {
        tx.insert(feedTags)
          .values(
            tagIds.map((tagId: number) => ({
              feedId: feed.id,
              tagId,
            })),
          )
          .run();
      }

      tx.insert(jobs)
        .values({
          kind: "feed.logo",
          payload: { feedId: feed.id },
        })
        .run();

      revalidatePath("/feeds");
      return { ok: true, id: feed.id };
    });
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function updateFeed(id: number, input: FeedInput) {
  const userId = await currentUserId();

  const name = input?.name;
  const aggregator = input?.aggregator;
  const identifier = input?.identifier || "";
  const options = input?.options || {};
  const tagIds = input?.tagIds || [];
  const enabled = input?.enabled;

  const feed = await getFeed(id);
  if (!feed) return { ok: false, error: "Not found" };

  const targetAggregator = aggregator || feed.aggregator;
  const spec = AGGREGATOR_SPECS[targetAggregator as keyof typeof AGGREGATOR_SPECS];
  if (!spec) return { ok: false, error: "Invalid aggregator" };

  if (spec.identifierRequired && !identifier && !feed.identifier) {
    return { ok: false, field: "identifier", error: "Identifier is required" };
  }

  const optionsParsed = schemaFor(spec.key).safeParse(options);
  if (!optionsParsed.success) {
    return { ok: false, error: "Invalid options" };
  }

  const capabilities = await capabilitiesFor();
  const cleanedOptions = stripUnavailable(
    spec.key,
    optionsParsed.data as Record<string, unknown>,
    capabilities,
  );

  return writeTransaction((tx) => {
    if (tagIds.length > 0) {
      const validTags = tx
        .select({ id: tags.id })
        .from(tags)
        .where(and(inArray(tags.id, tagIds), eq(tags.userId, userId)))
        .all();
      if (validTags.length !== tagIds.length) {
        return { ok: false, error: "Invalid tags" };
      }
    }

    tx.update(feeds)
      .set({
        ...(name !== undefined && { name }),
        ...(aggregator !== undefined && { aggregator: spec.key }),
        ...(identifier !== undefined && { identifier }),
        ...(options !== undefined && { options: cleanedOptions }),
        ...(enabled !== undefined && { enabled }),
      })
      .where(and(eq(feeds.id, id), eq(feeds.userId, userId)))
      .run();

    if (input.tagIds !== undefined) {
      tx.delete(feedTags).where(eq(feedTags.feedId, id)).run();
      if (tagIds.length > 0) {
        tx.insert(feedTags)
          .values(
            tagIds.map((tagId: number) => ({
              feedId: id,
              tagId,
            })),
          )
          .run();
      }
    }

    revalidatePath("/feeds");
    return { ok: true };
  });
}

export async function deleteFeeds(ids: number[]) {
  if (ids.length === 0) return { ok: true, deleted: 0 };

  const userId = await currentUserId();

  return writeTransaction((tx) => {
    const result = tx
      .delete(feeds)
      .where(and(inArray(feeds.id, ids), eq(feeds.userId, userId)))
      .run();
    revalidatePath("/feeds");
    return { ok: true, deleted: result.changes };
  });
}

export async function refreshLogos(ids: number[]): Promise<{ ok: boolean; enqueued: number }> {
  if (ids.length === 0) return { ok: true, enqueued: 0 };

  const userId = await currentUserId();

  return writeTransaction((tx) => {
    const validFeeds = tx
      .select({ id: feeds.id })
      .from(feeds)
      .where(and(inArray(feeds.id, ids), eq(feeds.userId, userId)))
      .all();

    if (validFeeds.length > 0) {
      tx.insert(jobs)
        .values(
          validFeeds.map((f) => ({
            kind: "feed.logo",
            payload: { feedId: f.id },
          })),
        )
        .run();
    }

    return { ok: true, enqueued: validFeeds.length };
  });
}

export async function updateFeedsBulk(ids: number[]): Promise<{ ok: boolean; enqueued: number }> {
  if (ids.length === 0) return { ok: true, enqueued: 0 };

  const userId = await currentUserId();

  return writeTransaction((tx) => {
    const validFeeds = tx
      .select({ id: feeds.id })
      .from(feeds)
      .where(and(inArray(feeds.id, ids), eq(feeds.userId, userId)))
      .all();

    if (validFeeds.length > 0) {
      tx.insert(jobs)
        .values(
          validFeeds.map((f) => ({
            kind: "feed.update",
            payload: { feedId: f.id },
          })),
        )
        .run();
    }

    return { ok: true, enqueued: validFeeds.length };
  });
}

export async function restoreFeedsBulk(ids: number[]): Promise<{ ok: boolean; enqueued: number }> {
  if (ids.length === 0) return { ok: true, enqueued: 0 };

  const userId = await currentUserId();

  return writeTransaction((tx) => {
    const validFeeds = tx
      .select({ id: feeds.id })
      .from(feeds)
      .where(and(inArray(feeds.id, ids), eq(feeds.userId, userId)))
      .all();

    if (validFeeds.length > 0) {
      tx.insert(jobs)
        .values(
          validFeeds.map((f) => ({
            kind: "feed.restore",
            payload: { feedId: f.id },
          })),
        )
        .run();
    }

    return { ok: true, enqueued: validFeeds.length };
  });
}
