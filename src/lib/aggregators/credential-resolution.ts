import { eq } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import { type Feed, userSettings } from "@/lib/db/schema";

/**
 * Merges the feed owner's stored integration credentials (Reddit, YouTube)
 * into a copy of the feed's `options`. Background aggregation has no signed-in
 * session to read `/integrations` state from, so without this the per-user
 * credentials configured there are unreachable and every aggregator silently
 * falls back to a single instance-wide env var (see
 * `getRedditUserSettings()` in `sites/reddit/auth.ts`).
 */
export function resolveFeedCredentials(feed: Feed): Feed {
  const settings = getDb()
    .select()
    .from(userSettings)
    .where(eq(userSettings.userId, feed.userId))
    .get();
  if (!settings) return feed;

  return {
    ...feed,
    options: {
      ...feed.options,
      reddit_enabled: settings.redditEnabled,
      reddit_client_id: settings.redditClientId,
      reddit_client_secret: settings.redditClientSecret,
      reddit_user_agent: settings.redditUserAgent,
      youtube_api_key: settings.youtubeApiKey,
    },
  };
}
