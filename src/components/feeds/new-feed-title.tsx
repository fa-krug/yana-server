"use client";

import { useTranslations } from "next-intl";

/**
 * The `/feeds/new` page's `<h1>`, extracted so the page body needs no
 * `await getTranslations()` at all -- the same technique
 * `src/components/settings/settings-title.tsx` uses, and for the same
 * reason: `useTranslations("feeds")` reads the `NextIntlClientProvider` the
 * root layout already renders, so nothing crosses the RSC boundary for the
 * title and nothing here suspends the page shell.
 *
 * The namespace is a **literal**, not a prop -- see `SettingsTitle`'s own
 * comment for why a shared generic `<PageTitle namespace titleKey>` is
 * rejected.
 */
export function NewFeedTitle() {
  const t = useTranslations("feeds");
  return <h1 className="text-2xl font-semibold">{t("newTitle")}</h1>;
}
