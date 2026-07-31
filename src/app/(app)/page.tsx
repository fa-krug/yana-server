import { getTranslations } from "next-intl/server";
import { Suspense } from "react";

import { CardSkeleton } from "@/components/data-skeleton";
import { getSettings } from "@/lib/settings/queries";

/**
 * The data region. Async, and rendered inside Suspense so the shell streams
 * first. This is the shape every list and detail view in phases 5-10 follows.
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
