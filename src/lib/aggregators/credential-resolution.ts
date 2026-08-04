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
 *
 * The owner's stored credentials take precedence over any same-named key that
 * might already exist in `feed.options` -- **but only when the integration is
 * actually configured**. These five keys (`reddit_enabled`,
 * `reddit_client_id`, `reddit_client_secret`, `reddit_user_agent`,
 * `youtube_api_key`) are credential fields that never legitimately live in a
 * feed's own options (the feed-options zod schema in `specs.ts` has no such
 * fields, and unknown keys are stripped before save), so a colliding value
 * there is stale or accidental, and a fresh, authoritative read from
 * `user_settings` is what must win.
 *
 * An **unconfigured** row is a different matter, and merging it unconditionally
 * was a bug. Every user has a `user_settings` row from provisioning, whether or
 * not they ever visited `/integrations`, and `reddit_user_agent` is NOT NULL
 * with the column default `"Yana/1.0"` -- a truthy string that defeats the `||`
 * chain in `getRedditUserSettings()` (`sites/reddit/auth.ts`) and so silently
 * overwrote an operator's `REDDIT_USER_AGENT`. The same held for the two
 * secrets: `/integrations`' probe stores a credential it *rejected*
 * (`reddit_enabled: false` -- see `judge()` in `lib/integrations/define.ts`),
 * and injecting that shadowed a working `REDDIT_CLIENT_ID`/`SECRET` env
 * fallback with a known-bad value.
 *
 * So each group is gated the way `searchFeedIdentifier()` in `./search` gates
 * it, and a failed gate **omits the keys entirely** rather than writing an
 * empty string -- whatever is already in `feed.options`, or the aggregator's
 * own env-var fallback, is then what gets consulted.
 */
export function resolveFeedCredentials(feed: Feed): Feed {
  const settings = getDb()
    .select()
    .from(userSettings)
    .where(eq(userSettings.userId, feed.userId))
    .get();
  if (!settings) return feed;

  const redditConfigured = Boolean(
    settings.redditEnabled && settings.redditClientId && settings.redditClientSecret,
  );

  return {
    ...feed,
    options: {
      ...feed.options,
      ...(redditConfigured
        ? {
            reddit_enabled: settings.redditEnabled,
            reddit_client_id: settings.redditClientId,
            reddit_client_secret: settings.redditClientSecret,
            reddit_user_agent: settings.redditUserAgent,
          }
        : {}),
      ...(settings.youtubeApiKey ? { youtube_api_key: settings.youtubeApiKey } : {}),
    },
  };
}
