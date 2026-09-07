"use client";

import { useTranslations } from "next-intl";

/**
 * The `/ai` page's description line, extracted so the page body needs no
 * `await getTranslations()` at all: `useTranslations("ai")` reads the
 * `NextIntlClientProvider` the root layout already renders, so nothing
 * crosses the RSC boundary for this text and nothing here suspends the page
 * shell. The page's `<h1>` is gone entirely -- the breadcrumb already names
 * the page -- so only the description remains.
 *
 * The namespace is a **literal**, not a prop -- see
 * `src/components/section-kit.tsx` for why a shared generic component with a
 * namespace parameter is rejected.
 */
export function AiDescription() {
  const t = useTranslations("ai");
  return <p className="text-sm text-muted-foreground">{t("description")}</p>;
}
