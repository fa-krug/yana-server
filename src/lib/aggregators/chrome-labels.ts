import { eq } from "drizzle-orm";
import { createTranslator } from "use-intl/core";

import { FALLBACK_LOCALE, type AppLocale } from "@/i18n/locale";
import { getDb } from "@/lib/db/client";
import { userSettings } from "@/lib/db/schema";

export interface ChromeLabels {
  comments: string;
  source: string;
  noCommentsYet: string;
  commentsDisabled: string;
  commentsUnavailable: string;
  viewVideoOnYoutube: string;
  viewVideo: string;
}

export const DEFAULT_CHROME_LABELS: ChromeLabels = {
  comments: "Comments",
  source: "source",
  noCommentsYet: "No comments yet.",
  commentsDisabled: "Comments disabled.",
  commentsUnavailable: "Comments unavailable.",
  viewVideoOnYoutube: "▶ View Video on YouTube",
  viewVideo: "▶ View Video",
};

/**
 * Resolves the chrome labels aggregators splice into article content
 * ("Comments" headings, per-comment "source" links, ...) in the feed
 * owner's own language. Background aggregation has no request to read a
 * locale from, so this follows the same per-user pattern as
 * `renderDigest()` (`src/lib/email/digest.ts`): read `user_settings.language`
 * directly, then render through `createTranslator` against that locale's
 * own catalog.
 *
 * Falls back to `DEFAULT_CHROME_LABELS` (English) without touching the
 * database at all when `userId` is missing -- every real aggregation/reload
 * run passes the feed owner's real id, but this keeps every site
 * aggregator's own unit tests (which construct feeds with no `userId`) from
 * needing a database connection.
 */
export async function resolveChromeLabels(
  userId: string | number | null | undefined,
): Promise<ChromeLabels> {
  if (userId === null || userId === undefined || userId === "") {
    return DEFAULT_CHROME_LABELS;
  }

  const settings = getDb()
    .select({ language: userSettings.language })
    .from(userSettings)
    .where(eq(userSettings.userId, String(userId)))
    .get();

  const locale: AppLocale = settings?.language === "de" ? "de" : FALLBACK_LOCALE;
  const messages = (await import(`../../../messages/${locale}.json`)).default;
  const t = createTranslator({ locale, messages, namespace: "aggregatorChrome" });

  return {
    comments: t("comments"),
    source: t("source"),
    noCommentsYet: t("noCommentsYet"),
    commentsDisabled: t("commentsDisabled"),
    commentsUnavailable: t("commentsUnavailable"),
    viewVideoOnYoutube: t("viewVideoOnYoutube"),
    viewVideo: t("viewVideo"),
  };
}
