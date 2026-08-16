"use client";

import { useTranslations } from "next-intl";

/**
 * The `/settings` page's `<h1>`, extracted so the page body needs no
 * `await getTranslations()` at all. `useTranslations("settings")` reads the
 * `NextIntlClientProvider` the root layout already renders -- nothing crosses
 * the RSC boundary for it, so nothing here suspends the page shell.
 *
 * The namespace is a **literal**, not a prop: a shared generic `<PageTitle
 * namespace titleKey>` was tried and rejected (see the streaming-controls
 * migration and `src/components/section-kit.tsx`) because making the
 * namespace generic while keeping catalog keys compiler-checked needs a cast
 * at the `t()` call site, which CLAUDE.md forbids. A literal namespace per
 * page avoids the wall entirely -- there is nothing generic left to reduce.
 */
export function SettingsTitle() {
  const t = useTranslations("settings");
  return <h1 className="text-2xl font-semibold">{t("title")}</h1>;
}
