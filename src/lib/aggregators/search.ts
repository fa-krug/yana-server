import type { AggregatorKey } from "@/lib/db/schema/enums";
import type { NamespaceKey } from "@/i18n/next-intl";
import { PROBE_TIMEOUT_MS, readJson, transportFailure } from "@/lib/integrations/probe";
import { fetchRedditAccessToken } from "@/lib/integrations/reddit";
import { getSettings } from "@/lib/settings/queries";

/**
 * The identifier-search server action for the two live-search aggregators.
 * Everything else (a fixed dropdown, a free URL, nothing to configure) needs
 * no server round trip -- see `identifierModeFor()` in `./specs`.
 */
export type IdentifierSearchResult =
  | { ok: true; results: { value: string; label: string }[] }
  | { ok: false; errorKey: NamespaceKey<"feeds"> };

const MIN_QUERY_LENGTH = 2;
const MAX_RESULTS = 10;

const UNAVAILABLE: IdentifierSearchResult = { ok: false, errorKey: "identifierSearch.unavailable" };

export async function searchFeedIdentifier(
  aggregator: AggregatorKey,
  query: string,
): Promise<IdentifierSearchResult> {
  const trimmed = query.trim();
  if (trimmed.length < MIN_QUERY_LENGTH) {
    return { ok: true, results: [] };
  }

  const settings = await getSettings();

  if (aggregator === "youtube") {
    if (!settings.youtubeEnabled || !settings.youtubeApiKey) return UNAVAILABLE;
    return searchYoutubeChannels(trimmed, settings.youtubeApiKey);
  }

  if (aggregator === "reddit") {
    if (!settings.redditEnabled || !settings.redditClientId || !settings.redditClientSecret) {
      return UNAVAILABLE;
    }
    return searchSubreddits(trimmed, {
      clientId: settings.redditClientId,
      clientSecret: settings.redditClientSecret,
      userAgent: settings.redditUserAgent,
    });
  }

  return UNAVAILABLE;
}

type YoutubeSearchResponse = { items?: { id?: { channelId?: string } }[] };
type YoutubeChannelsResponse = {
  items?: { id?: string; snippet?: { title?: string; customUrl?: string } }[];
};

/**
 * Ported from `search_channels()` in
 * `old/core/aggregators/youtube/aggregator.py`: a `search.list` for channel
 * ids, then a batched `channels.list` for title/handle. Never rejects --
 * every branch below returns `UNAVAILABLE` rather than throwing, and the one
 * `catch` covers a genuine transport failure the same way every probe in
 * `src/lib/integrations/*` does.
 */
async function searchYoutubeChannels(
  query: string,
  apiKey: string,
): Promise<IdentifierSearchResult> {
  try {
    const searchUrl = new URL("https://www.googleapis.com/youtube/v3/search");
    searchUrl.searchParams.set("part", "id");
    searchUrl.searchParams.set("q", query);
    searchUrl.searchParams.set("type", "channel");
    searchUrl.searchParams.set("maxResults", String(MAX_RESULTS));
    searchUrl.searchParams.set("key", apiKey);

    const searchResponse = await fetch(searchUrl, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!searchResponse.ok) return UNAVAILABLE;

    const searchBody = (await readJson(searchResponse)) as YoutubeSearchResponse | null;
    const channelIds = (searchBody?.items ?? [])
      .map((item) => item.id?.channelId)
      .filter((id): id is string => typeof id === "string");

    if (channelIds.length === 0) return { ok: true, results: [] };

    const channelsUrl = new URL("https://www.googleapis.com/youtube/v3/channels");
    channelsUrl.searchParams.set("part", "snippet");
    channelsUrl.searchParams.set("id", channelIds.join(","));
    channelsUrl.searchParams.set("key", apiKey);

    const channelsResponse = await fetch(channelsUrl, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!channelsResponse.ok) return UNAVAILABLE;

    const channelsBody = (await readJson(channelsResponse)) as YoutubeChannelsResponse | null;
    const results = (channelsBody?.items ?? [])
      .filter(
        (item): item is { id: string; snippet?: { title?: string; customUrl?: string } } =>
          typeof item.id === "string",
      )
      .map((item) => {
        const title = item.snippet?.title ?? item.id;
        const rawHandle = item.snippet?.customUrl;
        const handle = rawHandle ? (rawHandle.startsWith("@") ? rawHandle : `@${rawHandle}`) : "";
        return { value: item.id, label: handle ? `${title} (${handle})` : `${title} (${item.id})` };
      });

    return { ok: true, results };
  } catch (error) {
    transportFailure("youtube", error, "Could not reach the YouTube API.");
    return UNAVAILABLE;
  }
}

type RedditSearchResponse = {
  data?: {
    children?: { data?: { display_name?: string; title?: string; subscribers?: number } }[];
  };
};

/**
 * Ported from `get_identifier_choices()` in
 * `old/core/aggregators/reddit/aggregator.py`, translated from PRAW's
 * `subreddits.search()` to the plain REST endpoint it wraps
 * (`GET /subreddits/search`), authenticated the same client-credentials way
 * as the existing Reddit probe (`fetchRedditAccessToken`).
 */
async function searchSubreddits(
  query: string,
  credentials: { clientId: string; clientSecret: string; userAgent: string },
): Promise<IdentifierSearchResult> {
  try {
    const tokenResult = await fetchRedditAccessToken(credentials);
    if (!tokenResult.ok) return UNAVAILABLE;

    const url = new URL("https://oauth.reddit.com/subreddits/search");
    url.searchParams.set("q", query);
    url.searchParams.set("limit", String(MAX_RESULTS));

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${tokenResult.token}`,
        "User-Agent": credentials.userAgent,
      },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!response.ok) return UNAVAILABLE;

    const body = (await readJson(response)) as RedditSearchResponse | null;
    const results = (body?.data?.children ?? [])
      .map((child) => child.data)
      .filter(
        (data): data is { display_name: string; title?: string; subscribers?: number } =>
          typeof data?.display_name === "string",
      )
      .map((data) => ({
        value: data.display_name,
        label: `r/${data.display_name}: ${data.title ?? ""} (${(data.subscribers ?? 0).toLocaleString("en-US")} subs)`,
      }));

    return { ok: true, results };
  } catch (error) {
    transportFailure("reddit", error, "Could not reach the Reddit API.");
    return UNAVAILABLE;
  }
}
