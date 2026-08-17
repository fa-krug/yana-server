"use client";

import { useTranslations } from "next-intl";

/**
 * The dashboard's `<h1>`, extracted so the page body needs no
 * `await getTranslations()` at all -- see `src/components/settings/settings-title.tsx`
 * for the identical reasoning: a literal namespace per page rather than a
 * shared generic `<PageTitle>`, which needs a cast at the `t()` call site
 * that CLAUDE.md forbids.
 */
export function DashboardTitle() {
  const t = useTranslations("dashboard");
  return <h1 className="text-2xl font-semibold">{t("title")}</h1>;
}
