"use client";

import { useFormatter, useTranslations } from "next-intl";
import Link from "next/link";
import { Suspense, use } from "react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { RecentArticle } from "@/lib/dashboard/queries";

/**
 * The dashboard's "latest unread" card: the newest unread articles ordered by
 * publication date (`orderBy(desc(articles.date), ...)` in
 * `getRecentUnreadArticles()`), each linking to its detail page, with the
 * feed name and date beneath.
 *
 * The card frame and heading render always -- neither depends on `articles`.
 * `articles === undefined` (paired with `pending`) is the "not loaded yet"
 * state: the list's length is genuinely unknowable while pending, unlike a
 * field's value, so a `<Skeleton>` standing in for the list body is correct
 * here -- the same reasoning `/account`'s passkey and device lists document.
 * Do not "fix" this into the real empty state or a real list: neither is
 * known yet.
 *
 * Dates go through `format.dateTime(...)`, never `toLocaleDateString()`,
 * because the app pins a `timeZone` for exactly this reason (see CLAUDE.md)
 * -- an unpinned formatter would render a different day on the server than
 * in the browser.
 *
 * The empty state ("no unread articles") is true for both a fresh install
 * and a caught-up reader who has simply read everything -- it does not claim
 * the library is empty. The link still points at `/feeds/new` (verified to
 * exist under `src/app/(app)/feeds/new/`): a link is an offer to add a feed,
 * not a claim about why the list is empty.
 */
export function RecentArticlesView({
  articles,
  pending = false,
}: {
  articles?: RecentArticle[];
  pending?: boolean;
}) {
  const t = useTranslations("dashboard.recent");
  const format = useFormatter();
  const loading = pending || articles === undefined;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("heading")}</CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? (
          // Deliberate exception -- see the doc comment above.
          <div className="space-y-3">
            {Array.from({ length: 3 }, (_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : articles.length === 0 ? (
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

/** Calls use(); suspends until the promise resolves; renders the list for real. */
function RecentArticlesResolved({ promise }: { promise: Promise<RecentArticle[]> }) {
  const articles = use(promise);
  return <RecentArticlesView articles={articles} />;
}

/**
 * What the page renders. The fallback is the real card, in its pending
 * state -- see the Design Reference in
 * docs/superpowers/plans/2026-08-16-streaming-controls-migration.md -- so the
 * frame and heading are on screen from the first frame and only the list
 * streams in afterward.
 */
export function RecentArticles({ promise }: { promise: Promise<RecentArticle[]> }) {
  return (
    <Suspense fallback={<RecentArticlesView pending />}>
      <RecentArticlesResolved promise={promise} />
    </Suspense>
  );
}
