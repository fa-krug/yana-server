import { BookOpen, Newspaper, Rss, Tags, Workflow, type LucideIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { DashboardStats } from "@/lib/dashboard/queries";

type StatCardDef = {
  key: string;
  icon: LucideIcon;
  label: string;
  value: string;
  href: string;
};

/**
 * The dashboard's row of summary tiles: one per count on {@link DashboardStats},
 * each linking to the list page it summarises.
 *
 * Deliberately not `"use client"` -- it calls `useTranslations()`, which
 * next-intl supports in a synchronous server component (see `<UserAvatar>` for
 * the same pattern), and holds no state of its own.
 *
 * Feeds gets one tile for two numbers (`enabledFeeds` of `totalFeeds`), so
 * there are five tiles rather than six -- the sixth catalog value,
 * `stats.feedsValue`, is the "N of M" template that tile renders instead of a
 * bare count.
 */
export function StatCards({ stats }: { stats: DashboardStats }) {
  const t = useTranslations("dashboard.stats");

  const cards: StatCardDef[] = [
    {
      key: "unreadArticles",
      icon: BookOpen,
      label: t("unreadArticles"),
      value: String(stats.unreadArticles),
      href: "/articles?read=false",
    },
    {
      key: "totalArticles",
      icon: Newspaper,
      label: t("totalArticles"),
      value: String(stats.totalArticles),
      href: "/articles",
    },
    {
      key: "feeds",
      icon: Rss,
      label: t("feeds"),
      value: t("feedsValue", { enabled: stats.enabledFeeds, total: stats.totalFeeds }),
      href: "/feeds",
    },
    {
      key: "tags",
      icon: Tags,
      label: t("tags"),
      value: String(stats.tags),
      href: "/tags",
    },
    {
      key: "activeJobs",
      icon: Workflow,
      label: t("activeJobs"),
      value: String(stats.activeJobs),
      href: "/jobs",
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
      {cards.map((card) => (
        <Link key={card.key} href={card.href} className="block">
          <Card className="h-full transition-colors hover:bg-accent/50">
            <CardHeader className="flex-row items-center gap-2 space-y-0">
              <card.icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <CardTitle className="text-sm font-normal text-muted-foreground">
                {card.label}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-2xl font-semibold">{card.value}</p>
            </CardContent>
          </Card>
        </Link>
      ))}
    </div>
  );
}
