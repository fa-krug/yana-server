"use client";

import { useTranslations } from "next-intl";

/**
 * The `/ai` page's heading and description, extracted so the page body needs
 * no `await getTranslations()` at all -- the same technique
 * `src/components/settings/settings-title.tsx` uses, and for the same
 * reason: `useTranslations("ai")` reads the `NextIntlClientProvider` the
 * root layout already renders, so nothing crosses the RSC boundary for this
 * text and nothing here suspends the page shell.
 *
 * The namespace is a **literal**, not a prop -- see `SettingsTitle`'s own
 * comment for why a shared generic `<PageTitle namespace titleKey>` is
 * rejected.
 */
export function AiTitle() {
  const t = useTranslations("ai");
  return (
    <div className="space-y-2">
      <h1 className="text-2xl font-semibold">{t("title")}</h1>
      <p className="text-sm text-muted-foreground">{t("description")}</p>
    </div>
  );
}
