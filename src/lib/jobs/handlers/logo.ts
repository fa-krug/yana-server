import { eq } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import { feeds, type Job } from "@/lib/db/schema";
import { discoverLogo, storeLogo } from "@/lib/feeds/logo";

export async function handleLogoJob(job: Job): Promise<void> {
  const feedId = Number(job.payload?.feedId);
  if (!feedId) return;

  const db = getDb();
  const feed = db.select().from(feeds).where(eq(feeds.id, feedId)).get();
  if (!feed) return;

  const targetUrl = feed.logoSourceUrl || feed.identifier;
  if (!targetUrl) return;

  const logoResult = await discoverLogo(targetUrl);
  if (logoResult) {
    await storeLogo(feed.id, logoResult.bytes, logoResult.url);
  }
}
