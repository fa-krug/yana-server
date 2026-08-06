import Link from "next/link";
import { cache, Suspense } from "react";
import { getTranslations } from "next-intl/server";

import { Pagination } from "@/components/crud/pagination";
import { SearchFilterBar } from "@/components/crud/search-filter-bar";
import { TableRowsSkeleton } from "@/components/data-skeleton";
import { buttonVariants } from "@/components/ui/button";
import { TagsTableBody, TagsTableShell } from "@/components/tags/tags-table";
import { requireUser } from "@/lib/auth/session";
import { parseListParams, type ListParams } from "@/lib/crud/params";
import { listTags } from "@/lib/tags/queries";

// Body and Pagination below both read `{ rows, total }` for the same `params`
// object -- `cache()` (per request, like `getSettings()` elsewhere) turns that
// into one query rather than two.
const cachedListTags = cache(listTags);

async function TagsBody({ params }: { params: ListParams }) {
  const { rows } = await cachedListTags(params);
  return <TagsTableBody rows={rows} />;
}

async function TagsPagination({ params }: { params: ListParams }) {
  const { total } = await cachedListTags(params);
  return <Pagination page={params.page} pageSize={params.pageSize} total={total} />;
}

export default async function TagsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireUser();

  const params = parseListParams(await searchParams);
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

      {/* The table's chrome -- the bulk action bar and the header row, both
          defined in `<TagsTableShell>` -- is never keyed on the params: doing
          that produced two copies of the table side by side after a search,
          neither ever unmounting (see the doc comment on
          `<ListSelectionProvider>`). `resetKey` clears the selection on a new
          search or sort without remounting anything, and the header stays
          rendered throughout. Only the inner `<Suspense>` is keyed, so a
          param change shows its skeleton again rather than leaving the
          previous page's rows in place while the next query runs. */}
      <TagsTableShell resetKey={JSON.stringify(params)}>
        <Suspense key={JSON.stringify(params)} fallback={<TableRowsSkeleton columns={2} />}>
          <TagsBody params={params} />
        </Suspense>
      </TagsTableShell>

      <Suspense key={JSON.stringify(params)} fallback={null}>
        <TagsPagination params={params} />
      </Suspense>
    </div>
  );
}
