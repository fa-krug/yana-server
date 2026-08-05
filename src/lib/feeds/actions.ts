"use server";

import { and, eq, inArray, count, desc, asc, like } from "drizzle-orm";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import { revalidatePath } from "next/cache";

import { currentUserId } from "@/lib/auth/session";
import { getDb, writeTransaction } from "@/lib/db/client";
import { feeds, feedTags, tags, jobs, articles, articleTombstones } from "@/lib/db/schema";
import { getSettings } from "@/lib/settings/queries";
import type { ListParams } from "@/lib/crud/params";
import {
  AGGREGATOR_SPECS,
  defaultIdentifierFor,
  identifierModeFor,
  schemaFor,
  stripUnavailable,
  type AggregatorSpec,
  type Capabilities,
} from "@/lib/aggregators/specs";
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

/**
 * Snaps a `none`/`choice`-mode identifier to one of its known choices,
 * falling back to the default when the submitted value is empty or isn't
 * one of them. Mirrors Python's `normalize_identifier()`. `url`/`search`
 * modes pass through unchanged -- there's no fixed set to validate against.
 */
function normalizeIdentifier(spec: AggregatorSpec, identifier: string): string {
  const mode = identifierModeFor(spec);
  if (mode !== "none" && mode !== "choice") return identifier;

  const validValues = new Set(spec.identifierChoices.map((choice) => choice.value));
  return validValues.has(identifier) ? identifier : defaultIdentifierFor(spec);
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
      color: tags.color,
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
        color: tags.color,
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
    const options = input?.options || {};
    const tagIds = input?.tagIds || [];

    if (!name) return { ok: false, field: "name", error: "Name is required" };
    if (!aggregator) return { ok: false, field: "aggregator", error: "Aggregator is required" };

    const spec = AGGREGATOR_SPECS[aggregator as keyof typeof AGGREGATOR_SPECS];
    if (!spec) return { ok: false, error: "Invalid aggregator" };

    const identifier = normalizeIdentifier(spec, input?.identifier || "");

    if (spec.identifierRequired && !identifier) {
      return { ok: false, field: "identifier", error: "Identifier is required" };
    }

    const optionsParsed = schemaFor(spec.key).safeParse(options);
    if (!optionsParsed.success) {
      return { ok: false, error: "Invalid options" };
    }

    const capabilities = await capabilitiesFor();

    if (spec.identifierSearch && !capabilities[spec.identifierSearch]) {
      return { ok: false, error: "Invalid aggregator" };
    }

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
          userId,
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
  const tagIds = input?.tagIds || [];
  const enabled = input?.enabled;

  const feed = await getFeed(id);
  if (!feed) return { ok: false, error: "Not found" };

  const targetAggregator = aggregator || feed.aggregator;
  const spec = AGGREGATOR_SPECS[targetAggregator as keyof typeof AGGREGATOR_SPECS];
  if (!spec) return { ok: false, error: "Invalid aggregator" };

  /**
   * `undefined` means "the caller didn't submit this field, leave the
   * stored value alone" -- distinct from an explicitly empty string, which
   * is a request to clear it (and, for `none`/`choice` modes,
   * `normalizeIdentifier` snaps that back to the aggregator's default
   * rather than actually clearing it). This distinction is deliberately
   * *new*: the pre-existing `const identifier = input?.identifier || ""`
   * collapsed "omitted" and "submitted empty" into the same string, which
   * made the `identifier !== undefined` guard on the `.set()` call below
   * always true -- so calling `updateFeed(id, { name: "..." })` with no
   * `identifier` field silently wiped the feed's stored identifier to `""`
   * on every save. Nothing caught it: this file had no `updateFeed` test at
   * all before this task. Fixed here because it sits directly on the code
   * path this task is already restructuring, and left alone it would have
   * made the "keeps an existing reddit feed editable" test (Step 1, above) pass while
   * actually erasing that feed's subreddit on every rename.
   */
  const identifier =
    input?.identifier !== undefined ? normalizeIdentifier(spec, input.identifier) : undefined;

  if (spec.identifierRequired && !identifier && !feed.identifier) {
    return { ok: false, field: "identifier", error: "Identifier is required" };
  }

  /**
   * The same "omitted" versus "submitted" distinction the `identifier` fix
   * above makes, and for the same reason: `const options = input?.options || {}`
   * made `options` always defined, so the `options !== undefined` guard on the
   * `.set()` call below always fired -- and `schemaFor(spec.key).safeParse({})`
   * *applies defaults* rather than producing an empty object, so an update
   * that omitted `options` (a rename, a toggle of `enabled`, a tag change)
   * silently reset every per-feed option to its schema default. Parsing only
   * happens when the caller actually submitted something, and `undefined`
   * flows through to the spread otherwise.
   */
  let submittedOptions: Record<string, unknown> | undefined;
  if (input?.options !== undefined) {
    const parsed = schemaFor(spec.key).safeParse(input.options);
    if (!parsed.success) return { ok: false, error: "Invalid options" };
    submittedOptions = parsed.data as Record<string, unknown>;
  }

  const capabilities = await capabilitiesFor();

  const isAggregatorChange = aggregator !== undefined && aggregator !== feed.aggregator;
  if (isAggregatorChange && spec.identifierSearch && !capabilities[spec.identifierSearch]) {
    return { ok: false, error: "Invalid aggregator" };
  }

  const cleanedOptions =
    submittedOptions !== undefined
      ? stripUnavailable(spec.key, submittedOptions, capabilities)
      : undefined;

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
        ...(cleanedOptions !== undefined && { options: cleanedOptions }),
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

/**
 * Deleting a feed cascades to its articles at the schema level (`feeds.id`'s
 * FK is `onDelete: "cascade"`), so a client that synced before this call
 * would otherwise never learn those articles are gone. Every hard-delete
 * path on `articles` writes a tombstone first, in the same transaction --
 * see `deleteWithTombstones()` in `src/lib/jobs/handlers/retention.ts` for
 * the sibling path. This one starts from `feeds`, not `articles`, so it
 * looks up the doomed article ids itself rather than sharing that helper.
 */
export async function deleteFeeds(ids: number[]) {
  if (ids.length === 0) return { ok: true, deleted: 0 };

  const userId = await currentUserId();

  return writeTransaction((tx) => {
    const ownedFeeds = tx
      .select({ id: feeds.id })
      .from(feeds)
      .where(and(inArray(feeds.id, ids), eq(feeds.userId, userId)))
      .all();
    const ownedFeedIds = ownedFeeds.map((f) => f.id);

    if (ownedFeedIds.length > 0) {
      const doomedArticles = tx
        .select({ id: articles.id })
        .from(articles)
        .where(inArray(articles.feedId, ownedFeedIds))
        .all();

      if (doomedArticles.length > 0) {
        tx.insert(articleTombstones)
          .values(doomedArticles.map((a) => ({ articleId: a.id, userId })))
          .run();
      }
    }

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
            userId,
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
            userId,
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
            userId,
          })),
        )
        .run();
    }

    return { ok: true, enqueued: validFeeds.length };
  });
}
