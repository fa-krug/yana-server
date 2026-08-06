import { getTranslations } from "next-intl/server";

import { SearchFilterBar } from "@/components/crud/search-filter-bar";
import { TableRowsSkeleton } from "@/components/data-skeleton";
import { ArticlesTableShell } from "@/components/articles/articles-table";

/**
 * The route's own fallback, replacing `(app)/loading.tsx`'s generic
 * `<TableSkeleton>` for this segment specifically -- see
 * `src/app/(app)/feeds/loading.tsx` for the pattern this mirrors.
 *
 * This mirrors `ArticlesPage`'s real chrome: the same title (no "new" button
 * -- this page has none), the same `<ArticlesTableShell>` wrapping a
 * `<TableRowsSkeleton>` instead of the real body. The real page's
 * `<SearchFilterBar>` gets a `filters` array built from `listFeeds()`/
 * `listTags()` DB queries -- exactly the kind of data dependency this file
 * must not perform, since that would just move the slow await into the
 * fallback itself. So this renders `<SearchFilterBar>` with no `filters`
 * prop (defaults to `[]`): the filter dropdowns simply aren't present for
 * that brief instant, the same simplified-controls tradeoff
 * `src/app/(app)/settings/page.tsx`'s `SectionsFallback` makes.
 */
export default async function Loading() {
  const t = await getTranslations("articles");

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
      </div>

      <SearchFilterBar placeholder={t("searchPlaceholder")} />

      <ArticlesTableShell>
        <TableRowsSkeleton columns={5} />
      </ArticlesTableShell>
    </div>
  );
}
