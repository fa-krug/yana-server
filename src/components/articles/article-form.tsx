"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Suspense, use, useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { reloadArticles, updateArticle } from "@/lib/articles/actions";
import { attemptCall } from "@/lib/attempt";
import { useTrackRun } from "@/components/jobs/active-runs-context";
import type { Article, Feed } from "@/lib/db/schema";

type ArticleFeed = { id: number; name: string };

/**
 * `article`/`feeds` are optional and paired with `pending`, the same
 * "not loaded yet" shape as `@/components/feeds/feed-form.tsx` and
 * `@/components/settings/library-section.tsx`: the real form renders
 * disabled, with whatever values it already has, rather than a `<Skeleton>`
 * standing in for each control.
 *
 * `/articles/[id]/page.tsx` awaits `getArticle()` at the top of the page
 * body -- it decides the 404, so it cannot move into a `<Suspense>` boundary
 * -- so by the time this component is used with real data, `article` is
 * already known and only `feeds` is still streaming in. `pending` therefore
 * still disables every control even when `article` is present, matching
 * `<FeedForm>`'s `busy` behaviour: a known value with a disabled control
 * beats either blanking it or leaving a mismatched enabled state while a
 * sibling field is still unresolved. `article` is `undefined` only in
 * `/articles/[id]/loading.tsx`, before the row has been read at all.
 */
export function ArticleForm({
  article,
  feeds,
  pending = false,
}: {
  article?: Article & { feed: Feed };
  feeds?: ArticleFeed[];
  pending?: boolean;
}) {
  const t = useTranslations("articles");
  const router = useRouter();
  const trackRun = useTrackRun();
  const [isPending, startTransition] = useTransition();
  const [reloading, startReload] = useTransition();
  const busy = pending || isPending;

  function runReload() {
    if (!article) return;

    startReload(async () => {
      // Never a bare `await` of a server action from a client component (see
      // `@/lib/attempt`): an action that fails without returning -- a dropped
      // connection, the container restarting mid-request -- rejects inside this
      // transition scope and escalates to the (app) group's error boundary,
      // replacing the whole form with "Something went wrong". `attemptCall`
      // rather than a namespaced `attempt()` because `articles` has no binding
      // of its own, and one import is cheaper than one more module.
      const attempted = await attemptCall(() => reloadArticles([article.id]), {
        label: "Enqueueing an article reload rejected instead of returning",
      });
      if (attempted.status !== "returned" || !attempted.result.ok) {
        toast.error(t("saveFailed"));
        return;
      }

      // The count comes from the run, never from the one id submitted: the
      // article may have been deleted by another session between the click and
      // the enqueue, in which case nothing ran and "1 reloaded" would be a lie.
      trackRun(attempted.result.runId, {
        completed: (n) => t("reloadCompleted", { count: n }),
        partial: (ok, failed) => t("reloadCompletedWithFailures", { completed: ok, failed }),
        fallback: t("saveFailed"),
      });
    });
  }

  const [name, setName] = useState(article?.name ?? "");
  const [feedId, setFeedId] = useState<number | undefined>(article?.feedId);
  const [date, setDate] = useState(() => {
    if (!article) return "";
    const d = new Date(article.date);
    return Number.isNaN(d.getTime()) ? "" : d.toISOString().split("T")[0];
  });
  const [error, setError] = useState<string | null>(null);

  const feedList = feeds ?? [];
  const feedItems = feedList.map((f) => ({ value: String(f.id), label: f.name }));

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!article) return;
    setError(null);

    startTransition(async () => {
      const parsedDate = date ? new Date(date) : new Date(article.date);
      const res = await updateArticle(article.id, {
        name,
        feedId,
        date: parsedDate,
      });

      if (!res.ok) {
        setError(res.error || t("saveFailed"));
        toast.error(res.error || t("saveFailed"));
        return;
      }

      toast.success(t("saved"));
      router.refresh();
    });
  };

  const createdAtFormatted = article ? new Date(article.createdAt).toLocaleString() : "";

  return (
    <form onSubmit={handleSubmit} className="space-y-6 max-w-xl">
      {error && (
        <div className="rounded-md bg-destructive/15 p-3 text-sm text-destructive font-medium">
          {error}
        </div>
      )}

      <div className="space-y-2">
        <Label htmlFor="article-name">{t("name")}</Label>
        <Input
          id="article-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={busy}
          required
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="article-feed">{t("feed")}</Label>
        <Select
          items={feedItems}
          // `feedId` is only `undefined` while pending -- before `article` has
          // been read at all -- and `""` is reserved for a legal empty entry
          // in `items` (see CLAUDE.md), which this list never has, so
          // `undefined` rather than `String(feedId)` is what keeps this from
          // ever passing a stringified `"undefined"`.
          value={feedId === undefined ? undefined : String(feedId)}
          onValueChange={(val) => val && setFeedId(Number(val))}
          disabled={busy}
        >
          <SelectTrigger id="article-feed" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {feedItems.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-2">
        <Label htmlFor="article-date">{t("date")}</Label>
        <Input
          id="article-date"
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          disabled={busy}
          required
          // iOS Safari/WKWebView renders `type="date"` as `display: inline-block`
          // and sizes its shadow content by intrinsic width, ignoring the
          // percentage `width: 100%` the base Input class already sets in that
          // formatting context -- the field overflows its container and forces a
          // horizontal scrollbar on the whole page. `block` removes the
          // ambiguity; a block box's 100% width is unambiguous.
          className="block max-w-full"
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="article-created-at">{t("createdAt")}</Label>
        <Input
          id="article-created-at"
          value={createdAtFormatted}
          readOnly
          disabled
          className="bg-muted text-muted-foreground cursor-not-allowed"
        />
        <p className="text-xs text-muted-foreground">{t("createdAtNote")}</p>
      </div>

      <div className="flex flex-col gap-2 pt-2 sm:flex-row sm:items-center">
        <Button type="submit" disabled={busy} className="w-full sm:w-auto">
          {isPending ? t("save") + "..." : t("save")}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={busy || reloading}
          onClick={runReload}
          className="w-full sm:w-auto"
        >
          {t("reloadNow")}
        </Button>
      </div>
    </form>
  );
}

/**
 * Calls `use()` on the one promise still streaming; suspends until it
 * settles; renders the form for real. `article` is already known by the time
 * this is used -- `/articles/[id]/page.tsx` awaits `getArticle()` at the top
 * of the page body, because it decides the 404 -- so only `feeds` is a
 * promise here.
 */
function ArticleFormResolved({
  article,
  feedsPromise,
}: {
  article: Article & { feed: Feed };
  feedsPromise: Promise<ArticleFeed[]>;
}) {
  const feeds = use(feedsPromise);
  return <ArticleForm article={article} feeds={feeds} />;
}

/**
 * What `/articles/[id]/page.tsx`'s general section renders. The fallback is
 * `<ArticleForm article={article} pending />` -- the real chassis, disabled,
 * already carrying the fetched article's own name/date/created-at values --
 * so only the feed picker (needs `listFeeds()`) streams in afterward.
 */
export function ArticleFormSection({
  article,
  feedsPromise,
}: {
  article: Article & { feed: Feed };
  feedsPromise: Promise<ArticleFeed[]>;
}) {
  return (
    <Suspense fallback={<ArticleForm article={article} pending />}>
      <ArticleFormResolved article={article} feedsPromise={feedsPromise} />
    </Suspense>
  );
}
