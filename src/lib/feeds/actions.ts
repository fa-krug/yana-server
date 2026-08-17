"use server";

import { and, eq, inArray, count, desc, asc, like, sql } from "drizzle-orm";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { currentUserId } from "@/lib/auth/session";
import { getDb, writeTransaction } from "@/lib/db/client";
import { feeds, feedTags, tags, jobs, articles, articleTombstones } from "@/lib/db/schema";
import { enqueueRun } from "@/lib/jobs/queue";
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
import { DEFAULT_TAG_COLOR } from "@/lib/tags/colors";
import type { AggregatorKey } from "@/lib/db/schema/enums";
import type { ActionFailure } from "@/lib/attempt";
import type { NamespaceKey } from "@/i18n/next-intl";
import { decodeOpml, decodeOpmlOptions } from "./opml";

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

// 0 disables automatic updates for the feed (see scheduler.ts's tick());
// everything above that is a whole number of minutes. Concurrency bounds are
// a sanity range, not derived from anything -- 1 means "no overlap", 10 is
// comfortably above every aggregator's recommended value in specs.ts.
// 0 disables the age filter for the feed (see BaseAggregator.filterArticles()
// in src/lib/aggregators/base.ts); the upper bound matches
// articleRetentionDays' -- there's no point admitting an ingestion window
// wider than retention would keep anyway.
const schedulingSchema = z.object({
  updateIntervalMinutes: z.number().int().min(0).max(1440).optional(),
  concurrency: z.number().int().min(1).max(10).optional(),
  maxArticleAgeDays: z.number().int().min(0).max(3650).optional(),
});

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

/**
 * The columns `/feeds/[id]`'s form actually renders (see `FeedListRow` in
 * `src/components/feeds/feed-form.tsx`) plus `id`/`aggregator`/`identifier`,
 * which `updateFeed()` below also reads off this same read. Not selected:
 * `userId` (only ever a `WHERE`, never rendered), `dailyLimit`,
 * `redditSubredditId`, `youtubeChannelId`, `logoSourceUrl`, `logoImageHash`,
 * `createdAt`, `updatedAt` -- none of them read by the edit form or by
 * `updateFeed()`, so a bare `db.select()` was serializing eight unused
 * columns into the RSC payload of every render of this route (CLAUDE.md's "a
 * component gets the columns it renders, never the row").
 */
export async function getFeed(id: number) {
  const userId = await currentUserId();
  const db = getDb();

  const feed = db
    .select({
      id: feeds.id,
      name: feeds.name,
      aggregator: feeds.aggregator,
      identifier: feeds.identifier,
      enabled: feeds.enabled,
      options: feeds.options,
      updateIntervalMinutes: feeds.updateIntervalMinutes,
      concurrency: feeds.concurrency,
      maxArticleAgeDays: feeds.maxArticleAgeDays,
    })
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
  updateIntervalMinutes?: number;
  concurrency?: number;
  maxArticleAgeDays?: number;
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

    const schedulingParsed = schedulingSchema.safeParse({
      updateIntervalMinutes: input?.updateIntervalMinutes,
      concurrency: input?.concurrency,
      maxArticleAgeDays: input?.maxArticleAgeDays,
    });
    if (!schedulingParsed.success) {
      const field = schedulingParsed.error.issues[0]?.path[0];
      return {
        ok: false,
        field: typeof field === "string" ? field : undefined,
        error: "Invalid scheduling configuration",
      };
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
          ...(schedulingParsed.data.updateIntervalMinutes !== undefined && {
            updateIntervalMinutes: schedulingParsed.data.updateIntervalMinutes,
          }),
          ...(schedulingParsed.data.concurrency !== undefined && {
            concurrency: schedulingParsed.data.concurrency,
          }),
          ...(schedulingParsed.data.maxArticleAgeDays !== undefined && {
            maxArticleAgeDays: schedulingParsed.data.maxArticleAgeDays,
          }),
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

  const schedulingParsed = schedulingSchema.safeParse({
    updateIntervalMinutes: input?.updateIntervalMinutes,
    concurrency: input?.concurrency,
    maxArticleAgeDays: input?.maxArticleAgeDays,
  });
  if (!schedulingParsed.success) {
    const field = schedulingParsed.error.issues[0]?.path[0];
    return {
      ok: false,
      field: typeof field === "string" ? field : undefined,
      error: "Invalid scheduling configuration",
    };
  }

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
        ...(schedulingParsed.data.updateIntervalMinutes !== undefined && {
          updateIntervalMinutes: schedulingParsed.data.updateIntervalMinutes,
        }),
        ...(schedulingParsed.data.concurrency !== undefined && {
          concurrency: schedulingParsed.data.concurrency,
        }),
        ...(schedulingParsed.data.maxArticleAgeDays !== undefined && {
          maxArticleAgeDays: schedulingParsed.data.maxArticleAgeDays,
        }),
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

export async function refreshLogos(
  ids: number[],
): Promise<{ ok: boolean; enqueued: number; runId: number }> {
  const userId = await currentUserId();

  const validFeeds = getDb()
    .select({ id: feeds.id })
    .from(feeds)
    .where(and(inArray(feeds.id, ids), eq(feeds.userId, userId)))
    .all();

  const runId = enqueueRun(
    userId,
    "feed.logo",
    validFeeds.map((f) => ({ feedId: f.id })),
  );

  return { ok: true, enqueued: validFeeds.length, runId };
}

export async function updateFeedsBulk(
  ids: number[],
): Promise<{ ok: boolean; enqueued: number; runId: number }> {
  const userId = await currentUserId();

  const validFeeds = getDb()
    .select({ id: feeds.id })
    .from(feeds)
    .where(and(inArray(feeds.id, ids), eq(feeds.userId, userId)))
    .all();

  const runId = enqueueRun(
    userId,
    "feed.update",
    validFeeds.map((f) => ({ feedId: f.id })),
  );

  return { ok: true, enqueued: validFeeds.length, runId };
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

type FeedsKey = NamespaceKey<"feeds">;

export type OpmlPreviewEntry = {
  name: string;
  identifier: string;
  aggregatorLabel: string;
  tags: string[];
  status: "new" | "duplicate" | "invalid";
  reasonKey?: FeedsKey;
};

type OpmlClassified = {
  name: string;
  identifier: string;
  aggregatorKey: AggregatorKey;
  aggregatorLabel: string;
  tags: string[];
  status: "new" | "duplicate" | "invalid";
  reasonKey?: FeedsKey;
  options?: Record<string, unknown>;
  enabled?: boolean;
  dailyLimit?: number;
  updateIntervalMinutes?: number;
  concurrency?: number;
  maxArticleAgeDays?: number;
};

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  const rounded = Math.trunc(value);
  return rounded < min || rounded > max ? fallback : rounded;
}

/**
 * Shared by `previewOpmlImport` and `importOpmlFeeds` so the two can never
 * disagree about what a file contains: the preview shows exactly what the
 * import would do, because both call this.
 *
 * A "new" entry within the file that repeats an earlier "new" entry's
 * `(aggregator, identifier)` is classified `duplicate`, not `new` — `seen`
 * starts from the caller's existing feeds and grows as entries are
 * classified, so the second of two identical outlines in one file is caught
 * even though neither is in the database yet.
 */
async function resolveOpmlEntries(
  content: string,
  userId: string,
): Promise<{ ok: true; classified: OpmlClassified[] } | ActionFailure<"feeds">> {
  let entries: ReturnType<typeof decodeOpml>;
  try {
    entries = decodeOpml(content);
  } catch {
    return { ok: false, errorKey: "invalidOpmlFile" };
  }

  const db = getDb();
  const capabilities = await capabilitiesFor();

  const seen = new Set(
    db
      .select({ aggregator: feeds.aggregator, identifier: feeds.identifier })
      .from(feeds)
      .where(eq(feeds.userId, userId))
      .all()
      .map((row) => `${row.aggregator}:${row.identifier}`),
  );

  const classified = entries.map((entry): OpmlClassified => {
    const requestedSpec = entry.aggregatorType
      ? AGGREGATOR_SPECS[entry.aggregatorType as AggregatorKey]
      : undefined;
    const spec = requestedSpec ?? AGGREGATOR_SPECS.full_website;
    const identifier = normalizeIdentifier(spec, entry.identifier);
    const base = {
      name: entry.name,
      identifier,
      aggregatorKey: spec.key,
      aggregatorLabel: spec.label,
      tags: entry.tags,
    };

    /**
     * An outline with neither an `xmlUrl` nor a `yana:aggregatorType` is
     * foreign-reader junk (an empty folder, a separator, a text-only note),
     * not a real feed -- it would otherwise fall back to `full_website`,
     * whose `identifierRequired: false` lets it through as a `new` feed
     * that can never aggregate anything. A deliberately identifier-less
     * Yana `full_website` export always carries `yana:aggregatorType`, so
     * gating on the *combination* (not identifier alone) is what tells
     * "real Yana feed with an optional empty identifier" apart from this.
     * This must run before the `identifierRequired` check below, which
     * would otherwise never see this case for `full_website`.
     */
    if (!entry.identifier && !entry.aggregatorType) {
      return { ...base, status: "invalid", reasonKey: "importReasonMissingIdentifier" };
    }

    if (spec.identifierRequired && !identifier) {
      return { ...base, status: "invalid", reasonKey: "importReasonMissingIdentifier" };
    }

    if (spec.identifierSearch && !capabilities[spec.identifierSearch]) {
      return { ...base, status: "invalid", reasonKey: "importReasonCapabilityUnavailable" };
    }

    let options: Record<string, unknown> = {};
    if (entry.optionsBase64) {
      const decoded = decodeOpmlOptions(entry.optionsBase64);
      const parsed = decoded === null ? null : schemaFor(spec.key).safeParse(decoded);
      if (!parsed || !parsed.success) {
        return { ...base, status: "invalid", reasonKey: "importReasonInvalidOptions" };
      }
      options = stripUnavailable(spec.key, parsed.data as Record<string, unknown>, capabilities);
    }

    const key = `${spec.key}:${identifier}`;
    if (seen.has(key)) {
      return { ...base, status: "duplicate" };
    }
    seen.add(key);

    return {
      ...base,
      status: "new",
      options,
      enabled: entry.enabled ?? true,
      dailyLimit: clampInt(entry.dailyLimit, 20, 0, 1_000_000),
      updateIntervalMinutes: clampInt(
        entry.updateIntervalMinutes,
        spec.recommendedIntervalMinutes,
        0,
        1440,
      ),
      concurrency: clampInt(entry.concurrency, spec.recommendedConcurrency, 1, 10),
      maxArticleAgeDays: clampInt(entry.maxArticleAgeDays, 30, 0, 3650),
    };
  });

  return { ok: true, classified };
}

export async function previewOpmlImport(
  content: string,
): Promise<{ ok: true; entries: OpmlPreviewEntry[] } | ActionFailure<"feeds">> {
  const userId = await currentUserId();
  const resolved = await resolveOpmlEntries(content, userId);
  if (!resolved.ok) return resolved;

  return {
    ok: true,
    entries: resolved.classified.map((entry) => ({
      name: entry.name,
      identifier: entry.identifier,
      aggregatorLabel: entry.aggregatorLabel,
      tags: entry.tags,
      status: entry.status,
      reasonKey: entry.reasonKey,
    })),
  };
}

export async function importOpmlFeeds(
  content: string,
): Promise<{ ok: true; imported: number; skipped: number } | ActionFailure<"feeds">> {
  const userId = await currentUserId();
  const resolved = await resolveOpmlEntries(content, userId);
  if (!resolved.ok) return resolved;

  const newEntries = resolved.classified.filter((entry) => entry.status === "new");
  const skipped = resolved.classified.length - newEntries.length;

  if (newEntries.length === 0) {
    return { ok: true, imported: 0, skipped };
  }

  const imported = writeTransaction((tx) => {
    function resolveTagId(name: string): number {
      const existing = tx
        .select({ id: tags.id })
        .from(tags)
        .where(and(eq(tags.userId, userId), sql`lower(${tags.name}) = lower(${name})`))
        .get();
      if (existing) return existing.id;

      return tx
        .insert(tags)
        .values({ name, userId, color: DEFAULT_TAG_COLOR })
        .returning({ id: tags.id })
        .get().id;
    }

    for (const entry of newEntries) {
      const tagIds = entry.tags.map(resolveTagId);

      const feed = tx
        .insert(feeds)
        .values({
          name: entry.name,
          aggregator: entry.aggregatorKey,
          identifier: entry.identifier,
          options: entry.options ?? {},
          enabled: entry.enabled ?? true,
          dailyLimit: entry.dailyLimit ?? 20,
          updateIntervalMinutes: entry.updateIntervalMinutes ?? 30,
          concurrency: entry.concurrency ?? 4,
          maxArticleAgeDays: entry.maxArticleAgeDays ?? 30,
          userId,
        })
        .returning({ id: feeds.id })
        .get();

      // `resolveTagId` matches case-insensitively, so two `yana:tags` entries
      // differing only by case (e.g. "Tech,tech") resolve to the same tag id
      // twice -- deduping here is what keeps the `feedTags` insert from
      // trying to write the same `(feedId, tagId)` composite primary key
      // twice and rolling back the whole import.
      const uniqueTagIds = [...new Set(tagIds)];
      if (uniqueTagIds.length > 0) {
        tx.insert(feedTags)
          .values(uniqueTagIds.map((tagId) => ({ feedId: feed.id, tagId })))
          .run();
      }

      tx.insert(jobs)
        .values({ kind: "feed.logo", payload: { feedId: feed.id }, userId })
        .run();
    }

    revalidatePath("/feeds");
    return newEntries.length;
  });

  return { ok: true, imported, skipped };
}
