import { eq } from "drizzle-orm";

import { createAggregator } from "@/lib/aggregators/factory";
import { getDb } from "@/lib/db/client";
import { feeds, type Job } from "@/lib/db/schema";
import { discoverLogo, storeLogo } from "@/lib/feeds/logo";
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

  // The aggregator's getSourceUrl() is the site's homepage (e.g. Heise overrides it to
  // "https://www.heise.de/"); feed.identifier is frequently the RSS/feed URL itself, which has
  // no <link rel="icon"> tags to discover and pushes discoverLogo onto the bare "/favicon.ico"
  // fallback -- a classic .ico that sharp/libvips cannot decode.
  const targetUrl = feed.logoSourceUrl || createAggregator(feed).getSourceUrl();
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
