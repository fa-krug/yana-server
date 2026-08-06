import { getTranslations } from "next-intl/server";

import { SearchFilterBar } from "@/components/crud/search-filter-bar";
import { TableRowsSkeleton } from "@/components/data-skeleton";
import { JobsTableShell } from "@/components/jobs/jobs-table";

/**
 * The route's own fallback, replacing `(app)/loading.tsx`'s generic
 * `<TableSkeleton>` for this segment specifically -- see
 * `src/app/(app)/feeds/loading.tsx` for the pattern this mirrors.
 *
 * This mirrors `JobsPage`'s real chrome: the same title (no "new" button --
 * this page has none), the same `<SearchFilterBar>`, and the same
 * `<JobsTableShell>` wrapping a `<TableRowsSkeleton>` instead of the real
 * body. The real page's `showOwner`/column-count depend on
 * `isAdminRole(user.role)` from `requireUserFreshRole()`, which this file
 * cannot cheaply know -- checking it here would reintroduce the same
 * await-before-anything-renders problem this fix exists to solve. So this
 * renders the lower-privilege shape unconditionally: `showOwner={false}` and
 * `columns={5}`. For an admin the real page's extra "owner" column simply
 * appears a moment later, once it resolves -- a harmless partial mismatch,
 * not the chrome-less generic skeleton this file replaces.
 */
export default async function Loading() {
  const t = await getTranslations("jobs");

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
      </div>

      <SearchFilterBar placeholder={t("filterKind")} />

      <JobsTableShell showOwner={false}>
        <TableRowsSkeleton columns={5} />
      </JobsTableShell>
    </div>
  );
}
