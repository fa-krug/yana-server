import { Suspense } from "react";
import { getTranslations } from "next-intl/server";

import { ArticlesTable } from "@/components/articles/articles-table";
import { SearchFilterBar } from "@/components/crud/search-filter-bar";
import { TableSkeleton } from "@/components/data-skeleton";
import { listArticles } from "@/lib/articles/queries";
import { requireUser } from "@/lib/auth/session";
import { parseListParams, type ListParams } from "@/lib/crud/params";
import { listFeeds } from "@/lib/feeds/actions";
import { listTags } from "@/lib/tags/queries";

async function ArticlesData({ params }: { params: ListParams }) {
  const { rows, total } = await listArticles(params);

  return <ArticlesTable rows={rows} page={params.page} pageSize={params.pageSize} total={total} />;
}

export default async function ArticlesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireUser();

  const params = parseListParams(await searchParams);
  const t = await getTranslations("articles");

  const [feedsRes, tagsRes] = await Promise.all([
    listFeeds(parseListParams({ pageSize: "100" })),
    listTags(parseListParams({ pageSize: "100" })),
  ]);

  const feedOptions = feedsRes.rows.map((f) => ({
    value: String(f.id),
    label: f.name,
  }));

  const tagOptions = tagsRes.rows.map((t) => ({
    value: String(t.id),
    label: t.name,
    color: t.color,
  }));

  const filters = [
    {
      key: "feed",
      label: t("filters.feed"),
      options: feedOptions,
    },
    {
      key: "read",
      label: t("filters.read"),
      options: [
        { value: "true", label: t("filters.readOnly") },
        { value: "false", label: t("filters.unreadOnly") },
      ],
    },
    {
      key: "starred",
      label: t("filters.starred"),
      options: [
        { value: "true", label: t("filters.starredOnly") },
        { value: "false", label: t("filters.unstarredOnly") },
      ],
    },
    {
      key: "tag",
      label: t("filters.tag"),
      options: tagOptions,
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
      </div>

      <SearchFilterBar placeholder={t("searchPlaceholder")} filters={filters} />

      <Suspense key={JSON.stringify(params)} fallback={<TableSkeleton columns={5} />}>
        <ArticlesData params={params} />
      </Suspense>
    </div>
  );
}
