import { useFormatter, useTranslations } from "next-intl";
import Link from "next/link";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { RecentArticle } from "@/lib/dashboard/queries";

/**
 * The dashboard's "latest unread" card: the newest unread articles ordered by
 * publication date (`orderBy(desc(articles.date), ...)` in
 * `getRecentUnreadArticles()`), each linking to its detail page, with the
 * feed name and date beneath.
 *
 * Deliberately not `"use client"` -- see {@link StatCards} for why a
 * synchronous server component can still call `useTranslations()` (and here,
 * `useFormatter()`). Dates go through `format.dateTime(...)`, never
 * `toLocaleDateString()`, because the app pins a `timeZone` for exactly this
 * reason (see CLAUDE.md) -- an unpinned formatter would render a different day
 * on the server than in the browser.
 *
 * The empty state ("no unread articles") is true for both a fresh install
 * and a caught-up reader who has simply read everything -- it does not claim
 * the library is empty. The link still points at `/feeds/new` (verified to
 * exist under `src/app/(app)/feeds/new/`): a link is an offer to add a feed,
 * not a claim about why the list is empty.
 */
export function RecentArticles({ articles }: { articles: RecentArticle[] }) {
  const t = useTranslations("dashboard.recent");
  const format = useFormatter();

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("heading")}</CardTitle>
      </CardHeader>
      <CardContent>
        {articles.length === 0 ? (
          <div className="flex flex-col items-start gap-2 text-sm text-muted-foreground">
            <p>{t("empty")}</p>
            <Link
              href="/feeds/new"
              className="font-medium text-primary underline-offset-4 hover:underline"
            >
              {t("emptyCta")}
            </Link>
          </div>
        ) : (
          <ul className="divide-y">
            {articles.map((article) => (
              <li key={article.id} className="py-3 first:pt-0 last:pb-0">
                <Link href={`/articles/${article.id}`} className="font-medium hover:underline">
                  {article.name}
                </Link>
                <p className="text-sm text-muted-foreground">
                  {article.feedName} · {format.dateTime(article.date, { dateStyle: "medium" })}
                </p>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
