"use client";

import { useTranslations } from "next-intl";

import { SearchFilterBar } from "@/components/crud/search-filter-bar";

/**
 * The `/jobs` header (title only -- this page has no "new" action) and the
 * kind filter beneath it.
 *
 * A Client Component reading `useTranslations("jobs")` with a **literal**
 * namespace, so both keys stay compiler-checked against the catalogs, rather
 * than an async Server Component awaiting `getTranslations()`. The
 * instant-render-no-fallback migration (see `src/app/(app)/settings/page.tsx`)
 * needs `JobsPage`'s body to await nothing, and that awaited translation was
 * one of the three things standing in the way; the other two were
 * `await searchParams` and the page's own `requireUserFreshRole()` gate, which
 * moved into `listJobsForCurrentUser()` (`src/lib/jobs/queries.ts`) where the
 * rows are read and the owner filter is decided.
 *
 * Nothing here depends on the caller's role, which is why it can render before
 * that gate resolves: the owner *column* does, and lives in
 * `<JobsListRegion>`.
 */
export function JobsChrome() {
  const t = useTranslations("jobs");

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
      </div>

      <SearchFilterBar placeholder={t("filterKind")} />
    </>
  );
}
