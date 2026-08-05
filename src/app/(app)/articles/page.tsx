import { cache, Suspense } from "react";
import { getTranslations } from "next-intl/server";

import { ArticlesTableBody, ArticlesTableShell } from "@/components/articles/articles-table";
import { Pagination } from "@/components/crud/pagination";
import { SearchFilterBar } from "@/components/crud/search-filter-bar";
import { TableRowsSkeleton } from "@/components/data-skeleton";
import { listArticles } from "@/lib/articles/queries";
import { requireUser } from "@/lib/auth/session";
import { parseListParams, type ListParams } from "@/lib/crud/params";
import { listFeeds } from "@/lib/feeds/actions";
import { listTags } from "@/lib/tags/queries";

// Body and Pagination below both read `{ rows, total }` for the same `params`
// object -- `cache()` (per request, like `getSettings()` elsewhere) turns that
// into one query rather than two.
const cachedListArticles = cache(listArticles);

async function ArticlesBody({ params }: { params: ListParams }) {
  const { rows } = await cachedListArticles(params);
  return <ArticlesTableBody rows={rows} />;
}

async function ArticlesPagination({ params }: { params: ListParams }) {
  const { total } = await cachedListArticles(params);
  return <Pagination page={params.page} pageSize={params.pageSize} total={total} />;
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
      // `""`, not "all": an empty value clears the filter, so "All feeds"
      // produces a URL with no `feed` at all rather than `?feed=all`.
      options: [{ value: "", label: t("filters.allFeeds") }, ...feedOptions],
    },
    {
      key: "read",
      label: t("filters.read"),
      options: [
        { value: "", label: t("filters.allRead") },
        { value: "true", label: t("filters.readOnly") },
        { value: "false", label: t("filters.unreadOnly") },
      ],
    },
    {
      key: "starred",
      label: t("filters.starred"),
      options: [
        { value: "", label: t("filters.allStarred") },
        { value: "true", label: t("filters.starredOnly") },
        { value: "false", label: t("filters.unstarredOnly") },
      ],
    },
    {
      key: "tag",
      label: t("filters.tag"),
      options: [{ value: "", label: t("filters.allTags") }, ...tagOptions],
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
      </div>

      <SearchFilterBar placeholder={t("searchPlaceholder")} filters={filters} />

      {/* See src/app/(app)/tags/page.tsx for why the shell takes `resetKey`
          rather than a `key`, and why only the inner Suspense is keyed. */}
      <ArticlesTableShell resetKey={JSON.stringify(params)}>
        <Suspense key={JSON.stringify(params)} fallback={<TableRowsSkeleton columns={5} />}>
          <ArticlesBody params={params} />
        </Suspense>
      </ArticlesTableShell>

      <Suspense key={JSON.stringify(params)} fallback={null}>
        <ArticlesPagination params={params} />
      </Suspense>
    </div>
  );
}
