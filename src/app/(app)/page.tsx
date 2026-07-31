import { Suspense } from "react";

import { CardSkeleton } from "@/components/data-skeleton";
import { getSettings } from "@/lib/settings/queries";

/**
 * The data region. Async, and rendered inside Suspense so the shell streams
 * first. This is the shape every list and detail view in phases 5-10 follows.
 */
async function LibrarySummary() {
  const settings = await getSettings();
  return (
    <div className="rounded-lg border p-4">
      <p className="text-sm text-muted-foreground">
        Retention {settings.articleRetentionDays} days · updates every{" "}
        {settings.updateIntervalMinutes} minutes
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
