"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";

import { SearchFilterBar } from "@/components/crud/search-filter-bar";
import { ImportOpmlButton } from "@/components/feeds/import-opml-button";
import { buttonVariants } from "@/components/ui/button";
import { AGGREGATOR_SPECS } from "@/lib/aggregators/specs";

/**
 * The `/feeds` header (title + the three actions: Export OPML, Import OPML,
 * New) and the search/filter bar beneath it.
 *
 * A Client Component reading `useTranslations("feeds")`, not an async Server
 * Component awaiting `getTranslations()` -- the instant-render-no-fallback
 * migration (see `src/app/(app)/settings/page.tsx`) needs `FeedsPage`'s body
 * to await nothing, and this used to be the one thing standing in the way
 * (`{await FeedsChrome()}`). `useTranslations()` reads the
 * `NextIntlClientProvider` the root layout already renders, so nothing here
 * crosses the RSC boundary or suspends the page shell -- the same reasoning
 * `SettingsTitle` documents. Everything rendered here (the `feeds` catalog
 * and the static `AGGREGATOR_SPECS` table) needs no query either way.
 *
 * There used to be a second, hand-mirrored copy of this in `loading.tsx`,
 * which drifted from this one (missing the Export OPML link and
 * `<ImportOpmlButton>`, and no filters at all) -- that file is deleted now
 * that `FeedsPage` cannot suspend and the fallback is unreachable, so the
 * drift this component's extraction closed cannot reopen either.
 */
export function FeedsChrome() {
  const t = useTranslations("feeds");

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
