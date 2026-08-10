import Link from "next/link";
import { cache, Suspense } from "react";
import { getTranslations } from "next-intl/server";

import { Pagination } from "@/components/crud/pagination";
import { SearchFilterBar } from "@/components/crud/search-filter-bar";
import { TableRowsSkeleton } from "@/components/data-skeleton";
import { buttonVariants } from "@/components/ui/button";
import { FeedsTableBody, FeedsTableShell } from "@/components/feeds/feeds-table";
import { ImportOpmlButton } from "@/components/feeds/import-opml-button";
import { requireUser } from "@/lib/auth/session";
import { parseListParams, type ListParams } from "@/lib/crud/params";
import { listFeeds } from "@/lib/feeds/actions";
import { AGGREGATOR_SPECS } from "@/lib/aggregators/specs";

// Body and Pagination below both read `{ rows, total }` for the same `params`
// object -- `cache()` (per request, like `getSettings()` elsewhere) turns that
// into one query rather than two.
const cachedListFeeds = cache(listFeeds);

async function FeedsBody({ params }: { params: ListParams }) {
  const { rows } = await cachedListFeeds(params);
  return <FeedsTableBody rows={rows} />;
}

async function FeedsPagination({ params }: { params: ListParams }) {
  const { total } = await cachedListFeeds(params);
  return <Pagination page={params.page} pageSize={params.pageSize} total={total} />;
}

export default async function FeedsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireUser();

  const params = parseListParams(await searchParams);
  const t = await getTranslations("feeds");

  // Create filters for the search bar
  const aggregators = Object.values(AGGREGATOR_SPECS).map((s) => ({
    value: s.key,
    label: s.label,
  }));

  const filters = [
    {
      key: "aggregator",
      label: t("columns.aggregator"),
      // `""`, not "all": an empty value clears the filter, so "All
      // aggregators" produces a URL with no `aggregator` at all rather than
      // `?aggregator=all`.
      options: [{ value: "", label: t("allAggregators") }, ...aggregators],
    },
    {
      key: "enabled",
      label: t("columns.enabled"),
      options: [
        { value: "", label: t("allEnabled") },
        { value: "true", label: t("enabledTrue") },
        { value: "false", label: t("enabledFalse") },
      ],
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <div className="flex flex-wrap items-center gap-2">
          <a href="/api/feeds/export" className={buttonVariants({ variant: "outline" })}>
            {t("exportOpml")}
          </a>
          <ImportOpmlButton />
          <Link href="/feeds/new" className={buttonVariants()}>
            {t("new")}
          </Link>
        </div>
      </div>

      <SearchFilterBar placeholder={t("searchPlaceholder")} filters={filters} />

      {/* See src/app/(app)/tags/page.tsx for why the shell takes `resetKey`
          rather than a `key`, and why only the inner Suspense is keyed. */}
      <FeedsTableShell resetKey={JSON.stringify(params)}>
        <Suspense key={JSON.stringify(params)} fallback={<TableRowsSkeleton columns={6} />}>
          <FeedsBody params={params} />
        </Suspense>
      </FeedsTableShell>

      <Suspense key={JSON.stringify(params)} fallback={null}>
        <FeedsPagination params={params} />
      </Suspense>
    </div>
  );
}
