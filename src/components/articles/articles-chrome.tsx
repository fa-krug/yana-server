"use client";

import { Suspense, use } from "react";
import { useTranslations } from "next-intl";

import { SearchFilterBar } from "@/components/crud/search-filter-bar";

/**
 * The DB-dependent half of `/articles`' filters: the feed and tag *options*
 * `listFeeds()`/`listTags()` produce, already projected down to
 * `{ value, label }` (plus `color` for tags) -- never a whole `Feed`/`Tag`
 * row, which would serialize columns (a tag's `userId`, both rows'
 * timestamps) into this page's flight payload for nothing. The filter
 * *labels* ("Feed", "All feeds", "Read state", ...) are static catalog
 * strings, not DB data, so they are read with `useTranslations` below rather
 * than threaded through this promise.
 */
export type ArticleFilterOptions = {
  feeds: { value: string; label: string }[];
  tags: { value: string; label: string; color: string }[];
};

/**
 * The resolved half of the filter bar: `use()`s the options promise and
 * renders the real four filter selects alongside the search box.
 *
 * A separate component from `<ArticlesChrome>` on purpose -- `use()` on an
 * unresolved promise suspends its *own* component, and if this were inlined
 * into `<ArticlesChrome>` the title above it would suspend too. Splitting it
 * out and wrapping only this piece in `<Suspense>` is what lets the title and
 * the search box (which needs no DB read) render instantly while the filter
 * selects stream in once `listFeeds()`/`listTags()` resolve.
 */
function ArticlesFilterBar({
  placeholder,
  promise,
}: {
  placeholder: string;
  promise: Promise<ArticleFilterOptions>;
}) {
  const options = use(promise);
  const t = useTranslations("articles.filters");

  const filters = [
    {
      key: "feed",
      label: t("feed"),
      // `""`, not "all": an empty value clears the filter, so "All feeds"
      // produces a URL with no `feed` at all rather than `?feed=all`.
      options: [{ value: "", label: t("allFeeds") }, ...options.feeds],
    },
    {
      key: "read",
      label: t("read"),
      options: [
        { value: "", label: t("allRead") },
        { value: "true", label: t("readOnly") },
        { value: "false", label: t("unreadOnly") },
      ],
    },
    {
      key: "starred",
      label: t("starred"),
      options: [
        { value: "", label: t("allStarred") },
        { value: "true", label: t("starredOnly") },
        { value: "false", label: t("unstarredOnly") },
      ],
    },
    {
      key: "tag",
      label: t("tag"),
      options: [{ value: "", label: t("allTags") }, ...options.tags],
    },
  ];

  return <SearchFilterBar placeholder={placeholder} filters={filters} />;
}

/**
 * The `/articles` header (title, no "new" action -- this page has none) and
 * the search/filter bar beneath it.
 *
 * A Client Component reading `useTranslations("articles")`, not an async
 * Server Component awaiting `getTranslations()` -- the
 * instant-render-no-fallback migration (see `src/app/(app)/settings/page.tsx`)
 * needs `ArticlesPage`'s body to await nothing, and this used to be the one
 * thing standing in the way, along with the `listFeeds()`/`listTags()` reads
 * the old body awaited to build `filters`.
 *
 * The title and search box render immediately; the filter selects stream in
 * separately via `<ArticlesFilterBar>`, `<Suspense>`-wrapped here with a
 * fallback of the same `<SearchFilterBar>` but with **no `filters` prop** --
 * the same "genuinely unknown yet, so show none rather than a placeholder
 * guess" reasoning the deleted `loading.tsx` documented, just realized as a
 * real `<Suspense>` boundary instead of a route-level fallback.
 *
 * There used to be a second, hand-mirrored copy of the title and search box in
 * `loading.tsx`, deleted now that `ArticlesPage` cannot suspend and the
 * route-level fallback is unreachable.
 */
export function ArticlesChrome({
  optionsPromise,
}: {
  optionsPromise: Promise<ArticleFilterOptions>;
}) {
  const t = useTranslations("articles");

  return (
    <>
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
      </div>

      <Suspense fallback={<SearchFilterBar placeholder={t("searchPlaceholder")} />}>
        <ArticlesFilterBar placeholder={t("searchPlaceholder")} promise={optionsPromise} />
      </Suspense>
    </>
  );
}
