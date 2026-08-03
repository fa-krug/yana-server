import { and, eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

import { isAdminRole } from "@/lib/auth/roles";
import { AGGREGATOR_SPECS, defaultIdentifierFor } from "@/lib/aggregators/specs";
import { getDb, writeTransaction } from "@/lib/db/client";
import { feeds, feedTags, jobs, tags, users } from "@/lib/db/schema";
import type { AggregatorKey } from "@/lib/db/schema/enums";
import type { TagColorKey } from "@/lib/tags/colors";
import * as schema from "@/lib/db/schema";

/**
 * A handful of realistic sample tags, cycled across the seeded feeds so
 * `/tags` and its usage counts have something to show too.
 */
const SAMPLE_TAGS: { name: string; color: TagColorKey }[] = [
  { name: "News", color: "red" },
  { name: "Tech", color: "blue" },
  { name: "Entertainment", color: "violet" },
  { name: "Videos", color: "pink" },
  { name: "Comics", color: "amber" },
];

/**
 * Sample identifiers for the aggregators `AGGREGATOR_SPECS` has no
 * `identifierChoices` for -- the two free-form-URL types, the podcast type,
 * and the two live-search types (youtube/reddit), where any non-empty value
 * is a legal stored identifier even without calling the search API.
 */
const SAMPLE_IDENTIFIERS: Partial<Record<AggregatorKey, string>> = {
  full_website: "https://www.golem.de",
  feed_content: "https://hnrss.org/frontpage",
  podcast: "https://feeds.npr.org/510289/podcast.xml",
  youtube: "UC_x5XG1OV2P6uZZ5FSM9Ttw",
  reddit: "technology",
};

function identifierFor(key: AggregatorKey): string {
  const spec = AGGREGATOR_SPECS[key];
  const fromChoices = defaultIdentifierFor(spec);
  if (fromChoices) return fromChoices;
  return SAMPLE_IDENTIFIERS[key] ?? "";
}

type SeedSummary = { aggregator: AggregatorKey; created: boolean; feedId?: number; tag: string };

/**
 * Ensures one feed per aggregator in `AGGREGATOR_SPECS` exists for the given
 * user, each carrying one of `SAMPLE_TAGS` (created for the user if missing).
 * Skips any aggregator that already has a feed for this user, so re-running
 * this on a database that's already been seeded is a no-op per aggregator
 * rather than piling up duplicates.
 */
export function seedFeedsWithTags(
  db: BetterSQLite3Database<typeof schema>,
  userId: string,
): SeedSummary[] {
  return writeTransaction((tx) => {
    const tagIds = SAMPLE_TAGS.map(({ name, color }) => {
      const existing = tx
        .select({ id: tags.id })
        .from(tags)
        .where(and(eq(tags.userId, userId), eq(tags.name, name)))
        .get();
      if (existing) return existing.id;

      return tx.insert(tags).values({ name, color, userId }).returning({ id: tags.id }).get().id;
    });

    const aggregatorKeys = Object.keys(AGGREGATOR_SPECS) as AggregatorKey[];
    const summary: SeedSummary[] = [];

    aggregatorKeys.forEach((aggregator, index) => {
      const tagIndex = index % SAMPLE_TAGS.length;
      const tagId = tagIds[tagIndex];
      const tagName = SAMPLE_TAGS[tagIndex].name;

      const existingFeed = tx
        .select({ id: feeds.id })
        .from(feeds)
        .where(and(eq(feeds.userId, userId), eq(feeds.aggregator, aggregator)))
        .get();
      if (existingFeed) {
        summary.push({ aggregator, created: false, feedId: existingFeed.id, tag: tagName });
        return;
      }

      const spec = AGGREGATOR_SPECS[aggregator];
      const feed = tx
        .insert(feeds)
        .values({
          name: spec.label,
          aggregator,
          identifier: identifierFor(aggregator),
          userId,
        })
        .returning({ id: feeds.id })
        .get();

      tx.insert(feedTags).values({ feedId: feed.id, tagId }).run();
      tx.insert(jobs)
        .values({ kind: "feed.logo", payload: { feedId: feed.id } })
        .run();

      summary.push({ aggregator, created: true, feedId: feed.id, tag: tagName });
    });

    return summary;
  });
}

/**
 * Prefers a usable admin -- the account whose credentials (`admin@admin.com` /
 * `admin` on a fresh install) are actually known and can sign in to look at
 * the result -- falling back to whichever user row comes first when no admin
 * exists yet.
 */
function pickUser(db: BetterSQLite3Database<typeof schema>) {
  const rows = db.select({ id: users.id, email: users.email, role: users.role }).from(users).all();
  return rows.find((row) => isAdminRole(row.role)) ?? rows[0];
}

function main(): void {
  const db = getDb();

  const user = pickUser(db);
  if (!user) {
    console.error("No user found -- start the app once so the admin bootstrap can create one.");
    process.exit(1);
  }

  const summary = seedFeedsWithTags(db, user.id);

  console.log(`Seeding feeds for ${user.email}\n`);
  for (const row of summary) {
    const status = row.created ? "created" : "skipped (already exists)";
    console.log(`  ${row.aggregator.padEnd(14)} #${row.feedId} [${row.tag}] -- ${status}`);
  }

  const createdCount = summary.filter((row) => row.created).length;
  console.log(`\n${createdCount} feed(s) created, ${summary.length - createdCount} skipped.`);
}

main();
