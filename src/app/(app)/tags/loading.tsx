import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { SearchFilterBar } from "@/components/crud/search-filter-bar";
import { TableRowsSkeleton } from "@/components/data-skeleton";
import { TagsTableShell } from "@/components/tags/tags-table";
import { buttonVariants } from "@/components/ui/button";

/**
 * The route's own fallback, replacing `(app)/loading.tsx`'s generic
 * `<TableSkeleton>` for this segment specifically. Without this file, an
 * initial navigation to `/tags` shows that unrelated fallback for however
 * long `TagsPage` takes to resolve -- title-less, header-less, nothing like
 * the table it precedes -- because the whole async page function (including
 * its synchronous chrome) suspends as one unit until it returns.
 *
 * This mirrors `TagsPage`'s real chrome: the same title, the same
 * `<TagsTableShell>` (bulk-action bar + real header row, no dependency on
 * `rows`), with `<TableRowsSkeleton>` standing in for the body it wraps in a
 * `<Suspense>` there.
 */
export default async function Loading() {
  const t = await getTranslations("tags");

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <Link href="/tags/new" className={buttonVariants()}>
          {t("new")}
        </Link>
      </div>

      <SearchFilterBar placeholder={t("searchPlaceholder")} />

      <TagsTableShell>
        <TableRowsSkeleton columns={2} />
      </TagsTableShell>
    </div>
  );
}
