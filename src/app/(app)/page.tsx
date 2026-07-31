import { getTranslations } from "next-intl/server";
import { Suspense } from "react";

import { CardSkeleton } from "@/components/data-skeleton";
import { getSettings } from "@/lib/settings/queries";

/**
 * The data region. Async, and rendered inside Suspense so the shell streams
 * first. This is the shape every list and detail view in phases 5-10 follows.
 *
 * The pattern is <Suspense> **plus an error boundary**, not Suspense alone.
 * The two are halves of one thing: streaming means the shell's first byte --
 * and with it a 200 status -- is already sent before this component resolves,
 * so a throw here can no longer become an HTTP error status. Without
 * src/app/(app)/error.tsx above it, the response would simply be truncated and
 * the user would be left on a half-drawn page. Copy both.
 *
 * Note that CardSkeleton never actually paints on *this* route: getSettings()
 * is cache()d and the root layout already awaited it for the locale, so the
 * call below resolves from that cache within the same render tick and Suspense
 * has nothing to wait for. That is specific to this placeholder page reading
 * the one row the layout already read -- phases 5-10's real queries (feeds,
 * articles, tags) are not in that cache and will genuinely suspend, so the
 * fallback is load-bearing there. Do not conclude from an unseen skeleton here
 * that the pattern does not work.
 *
 * A Server Component, so translations come from getTranslations() (next-intl's
 * server API), not the useTranslations() hook used by the client chrome in
 * app-sidebar.tsx / route-breadcrumbs.tsx. One ICU message with two
 * placeholders, not two concatenated fragments -- en and de order the clauses
 * differently, and string concatenation can't express that.
 */
async function LibrarySummary() {
  const settings = await getSettings();
  const t = await getTranslations("dashboard");
  return (
    <div className="rounded-lg border p-4">
      <p className="text-sm text-muted-foreground">
        {t("librarySummary", {
          days: settings.articleRetentionDays,
          minutes: settings.updateIntervalMinutes,
        })}
      </p>
    </div>
  );
}

export default function DashboardPage() {
  return (
    <div className="space-y-4">
      {/* Renders immediately -- not inside Suspense. */}
      <h1 className="text-2xl font-semibold">Yana</h1>
      <Suspense fallback={<CardSkeleton />}>
        <LibrarySummary />
      </Suspense>
    </div>
  );
}
