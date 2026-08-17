"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";

import { SearchFilterBar } from "@/components/crud/search-filter-bar";
import { buttonVariants } from "@/components/ui/button";

/**
 * The `/tags` header (title + "New tag") and the search bar beneath it.
 *
 * A Client Component reading `useTranslations("tags")`, not an async Server
 * Component awaiting `getTranslations()` -- the instant-render-no-fallback
 * migration (see `src/app/(app)/settings/page.tsx`) needs `TagsPage`'s body
 * to await nothing, and this used to be the one thing standing in the way.
 * `useTranslations()` reads the `NextIntlClientProvider` the root layout
 * already renders, so nothing here crosses the RSC boundary or suspends the
 * page shell -- the same reasoning `FeedsChrome` documents. `/tags` has no
 * DB-backed filter options (unlike `/articles`), so unlike `<ArticlesChrome>`
 * this needs no streamed promise at all.
 *
 * There used to be a second, hand-mirrored copy of this in `loading.tsx`,
 * which is deleted now that `TagsPage` cannot suspend and the fallback is
 * unreachable.
 */
export function TagsChrome() {
  const t = useTranslations("tags");

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <Link href="/tags/new" className={buttonVariants()}>
          {t("new")}
        </Link>
      </div>

      <SearchFilterBar placeholder={t("searchPlaceholder")} />
    </>
  );
}
