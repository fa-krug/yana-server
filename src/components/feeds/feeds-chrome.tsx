import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { SearchFilterBar } from "@/components/crud/search-filter-bar";
import { ImportOpmlButton } from "@/components/feeds/import-opml-button";
import { buttonVariants } from "@/components/ui/button";
import { AGGREGATOR_SPECS } from "@/lib/aggregators/specs";

/**
 * The `/feeds` header (title + the three actions: Export OPML, Import OPML,
 * New) and the search/filter bar beneath it, shared verbatim between
 * `FeedsPage` and its `loading.tsx` fallback.
 *
 * It used to be two hand-mirrored copies, and they drifted: the fallback
 * rendered only the "New" link (missing Export OPML and `<ImportOpmlButton>`)
 * and no `<SearchFilterBar filters>` at all, despite a doc comment there
 * claiming the filters were already reproduced. One component that both
 * `page.tsx` and `loading.tsx` render is what makes that drift impossible
 * rather than merely documented against.
 *
 * Everything rendered here is available with no query -- the `feeds`
 * catalog and the static `AGGREGATOR_SPECS` table -- so calling this from a
 * fallback performs no data fetch of its own; `getTranslations()` is also
 * `cache()`d per request, so calling it here in addition to `FeedsPage`'s own
 * call is one lookup, not two.
 */
export async function FeedsChrome() {
  const t = await getTranslations("feeds");

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
    <>
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
    </>
  );
}
