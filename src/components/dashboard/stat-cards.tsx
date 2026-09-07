"use client";

import { BookOpen, Newspaper, Rss, Tags, type LucideIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { Suspense, use } from "react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
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
 * `stats === undefined` (paired with `pending`) is the "not loaded yet" state.
 * The card frame, its icon and its title render always -- none of the three
 * depends on `stats` -- and only the number is replaced by a small
 * `<Skeleton className="h-8 w-16" />`. A count has no honest "empty"
 * rendering the way a text field's empty string is, so this is one of only
 * three places in the whole migration where a skeleton survives by design
 * (the other two are `/account`'s passkey and device lists). Do not "fix"
 * this into a real `<p>` showing `0` or "" -- neither is true yet.
 *
 * Feeds gets one tile for two numbers (`enabledFeeds` of `totalFeeds`), so
 * there are four tiles rather than five -- the fifth catalog value,
 * `stats.feedsValue`, is the "N of M" template that tile renders instead of a
 * bare count.
 */
export function StatCardsView({
  stats,
  pending = false,
}: {
  stats?: DashboardStats;
  pending?: boolean;
}) {
  const t = useTranslations("dashboard.stats");
  const loading = pending || stats === undefined;

  const cards: StatCardDef[] = [
    {
      key: "unreadArticles",
      icon: BookOpen,
      label: t("unreadArticles"),
      value: stats ? String(stats.unreadArticles) : "",
      href: "/articles?read=false",
    },
    {
      key: "totalArticles",
      icon: Newspaper,
      label: t("totalArticles"),
      value: stats ? String(stats.totalArticles) : "",
      href: "/articles",
    },
    {
      key: "feeds",
      icon: Rss,
      label: t("feeds"),
      value: stats ? t("feedsValue", { enabled: stats.enabledFeeds, total: stats.totalFeeds }) : "",
      href: "/feeds",
    },
    {
      key: "tags",
      icon: Tags,
      label: t("tags"),
      value: stats ? String(stats.tags) : "",
      href: "/tags",
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      {cards.map((card) => (
        <Link key={card.key} href={card.href} className="block">
          <Card className="h-full transition-colors hover:bg-accent/50">
            <CardHeader className="flex flex-row items-center gap-2">
              <card.icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <CardTitle className="text-sm font-normal text-muted-foreground">
                {card.label}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {loading ? (
                // Deliberate exception -- see the doc comment above.
                <Skeleton className="h-8 w-16" />
              ) : (
                <p className="text-2xl font-semibold">{card.value}</p>
              )}
            </CardContent>
          </Card>
        </Link>
      ))}
    </div>
  );
}

/** Calls use(); suspends until the promise resolves; renders the tiles for real. */
function StatCardsResolved({ promise }: { promise: Promise<DashboardStats> }) {
  const stats = use(promise);
  return <StatCardsView stats={stats} />;
}

/**
 * What the page renders. The fallback is the real tiles, in their pending
 * state -- see the Design Reference in
 * docs/superpowers/plans/2026-08-16-streaming-controls-migration.md -- so
 * every card's frame, icon and title are on screen from the first frame and
 * only the number streams in afterward.
 */
export function StatCards({ promise }: { promise: Promise<DashboardStats> }) {
  return (
    <Suspense fallback={<StatCardsView pending />}>
      <StatCardsResolved promise={promise} />
    </Suspense>
  );
}
