import Link from "next/link";
import { Suspense } from "react";
import { getTranslations } from "next-intl/server";

import { SearchFilterBar } from "@/components/crud/search-filter-bar";
import { TableSkeleton } from "@/components/data-skeleton";
import { buttonVariants } from "@/components/ui/button";
import { FeedsTable } from "@/components/feeds/feeds-table";
import { requireUser } from "@/lib/auth/session";
import { parseListParams, type ListParams } from "@/lib/crud/params";
import { listFeeds } from "@/lib/feeds/actions";
import { AGGREGATOR_SPECS } from "@/lib/aggregators/specs";

async function FeedsData({ params }: { params: ListParams }) {
  const { rows, total } = await listFeeds(params);

  return <FeedsTable rows={rows} page={params.page} pageSize={params.pageSize} total={total} />;
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
      options: aggregators,
    },
    {
      key: "enabled",
      label: t("columns.enabled"),
      options: [
        { value: "true", label: t("enabledTrue") },
        { value: "false", label: t("enabledFalse") },
      ],
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <Link href="/feeds/new" className={buttonVariants()}>
          {t("new")}
        </Link>
      </div>

      <SearchFilterBar placeholder={t("searchPlaceholder")} filters={filters} />

      <Suspense key={JSON.stringify(params)} fallback={<TableSkeleton columns={6} />}>
        <FeedsData params={params} />
      </Suspense>
    </div>
  );
}
