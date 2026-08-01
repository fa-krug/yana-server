import Link from "next/link";
import { Suspense } from "react";
import { getTranslations } from "next-intl/server";

import { SearchFilterBar } from "@/components/crud/search-filter-bar";
import { TableSkeleton } from "@/components/data-skeleton";
import { buttonVariants } from "@/components/ui/button";
import { TagsTable } from "@/components/tags/tags-table";
import { requireUser } from "@/lib/auth/session";
import { parseListParams, type ListParams } from "@/lib/crud/params";
import { listTags } from "@/lib/tags/queries";

async function TagsData({ params }: { params: ListParams }) {
  const { rows, total } = await listTags(params);

  return <TagsTable rows={rows} page={params.page} pageSize={params.pageSize} total={total} />;
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

      <Suspense key={JSON.stringify(params)} fallback={<TableSkeleton columns={2} />}>
        <TagsData params={params} />
      </Suspense>
    </div>
  );
}
