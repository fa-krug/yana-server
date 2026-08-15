import { useTranslations } from "next-intl";
import Link from "next/link";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { CatalogKey } from "@/i18n/next-intl";
import { NAV_ITEMS } from "@/lib/nav";

/**
 * A key under the `dashboard.sections` namespace -- typed narrowly at its
 * source (here, rather than cast at the `t()` call site) the same way
 * `NavLabelKey` is derived in `src/lib/nav.ts`.
 */
type DescriptionKey = Extract<CatalogKey, `dashboard.sections.${string}`>;

/**
 * One description per nav route this grid can show a card for. Deliberately
 * not `dashboard.sections.heading` -- that key belongs to the grid's own
 * heading, not to any one card, so it is read directly rather than through
 * this table.
 *
 * A route with no entry here (there is none today, but a future NAV_ITEMS
 * addition could land before its description does) renders its card with the
 * label alone -- see the `descriptionKey &&` guard below.
 */
const DESCRIPTIONS: Partial<Record<string, DescriptionKey>> = {
  "/articles": "dashboard.sections.articles",
  "/feeds": "dashboard.sections.feeds",
  "/tags": "dashboard.sections.tags",
  "/users": "dashboard.sections.users",
  "/integrations": "dashboard.sections.integrations",
  "/ai": "dashboard.sections.ai",
  "/jobs": "dashboard.sections.jobs",
  "/settings": "dashboard.sections.settings",
};

/**
 * The dashboard's grid of every section a user can reach, one card per
 * {@link NAV_ITEMS} entry -- filtered exactly as `<AppSidebar>` filters it
 * (`!item.adminOnly || isAdmin`), plus `item.href !== "/"` to skip the
 * dashboard's own future nav entry (Task 3 adds it): a card linking to the
 * page it is already rendered on is noise, not navigation.
 *
 * Deliberately not `"use client"` -- see {@link StatCards} for why a
 * synchronous server component can still call `useTranslations()`.
 */
export function SectionCards({ isAdmin }: { isAdmin: boolean }) {
  const t = useTranslations();

  const items = NAV_ITEMS.filter((item) => item.href !== "/" && (!item.adminOnly || isAdmin));

  return (
    <div>
      <h2 className="mb-3 text-lg font-medium">{t("dashboard.sections.heading")}</h2>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {items.map((item) => {
          const descriptionKey = DESCRIPTIONS[item.href];
          return (
            <Link key={item.href} href={item.href} className="block">
              <Card className="h-full transition-colors hover:bg-accent/50">
                <CardHeader className="flex flex-row items-center gap-2">
                  <item.icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <CardTitle className="text-sm">{t(item.labelKey)}</CardTitle>
                </CardHeader>
                {descriptionKey ? (
                  <CardContent>
                    <p className="text-sm text-muted-foreground">{t(descriptionKey)}</p>
                  </CardContent>
                ) : null}
              </Card>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
