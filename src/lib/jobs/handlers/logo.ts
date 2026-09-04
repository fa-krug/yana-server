import { eq } from "drizzle-orm";

import { resolveFeedCredentials } from "@/lib/aggregators/credential-resolution";
import { createAggregator } from "@/lib/aggregators/factory";
import { getDb } from "@/lib/db/client";
import { feeds, type Job } from "@/lib/db/schema";
import { discoverLogo, fetchIconBytes, storeLogo } from "@/lib/feeds/logo";
import { appendLogLine } from "../queue";

export async function handleLogoJob(job: Job): Promise<void> {
  const feedId = Number(job.payload?.feedId);
  if (!feedId) return;

  const db = getDb();
  const feed = db.select().from(feeds).where(eq(feeds.id, feedId)).get();
  if (!feed) {
    appendLogLine(job.id, "stdout", "feed not found, skipping");
    return;
  }

  // Without this, logoImageUrl() has no credentials to call the YouTube/Reddit
  // API with, always throws, and the job silently falls through to generic
  // favicon discovery against the site's homepage -- see aggregate.ts, which
  // resolves credentials the same way for the same reason.
  const aggregator = createAggregator(resolveFeedCredentials(feed));

  // Tier 1: an aggregator-provided image -- a subreddit's icon, a YouTube channel's avatar --
  // is already a direct image URL, not a page to run favicon discovery against. Only Reddit and
  // YouTube implement this today; every other aggregator's logoImageUrl() stays the base no-op.
  const apiImageUrl = await aggregator.logoImageUrl().catch(() => null);
  if (apiImageUrl) {
    const bytes = await fetchIconBytes(apiImageUrl);
    if (bytes) {
      await storeLogo(feed.id, bytes, apiImageUrl);
      appendLogLine(job.id, "stdout", `stored logo from ${apiImageUrl}`);
      return;
    }
  }

  // The aggregator's getSourceUrl() is the site's homepage (e.g. Heise declares it as
  // "https://www.heise.de/" -- see `siteUrl` in src/lib/aggregators/define-site.ts, which is
  // what a site class states it through); feed.identifier is frequently the RSS/feed URL itself, which has
  // no <link rel="icon"> tags to discover and pushes discoverLogo onto the bare "/favicon.ico"
  // fallback -- a classic .ico that sharp/libvips cannot decode.
  const targetUrl = feed.logoSourceUrl || aggregator.getSourceUrl();
  if (!targetUrl) {
    appendLogLine(job.id, "stdout", "no logo source configured, skipping");
    return;
  }

  const logoResult = await discoverLogo(targetUrl);
  if (logoResult) {
    await storeLogo(feed.id, logoResult.bytes, logoResult.url);
    appendLogLine(job.id, "stdout", `stored logo from ${logoResult.url}`);
  } else {
    appendLogLine(job.id, "stdout", "no logo found");
  }
}
