"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
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

export function ArticleForm({
  article,
  feeds,
}: {
  article: Article & { feed: Feed };
  feeds: { id: number; name: string }[];
}) {
  const t = useTranslations("articles");
  const router = useRouter();
  const trackRun = useTrackRun();
  const [isPending, startTransition] = useTransition();
  const [reloading, startReload] = useTransition();

  function runReload() {
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

  const [name, setName] = useState(article.name);
  const [feedId, setFeedId] = useState(article.feedId);
  const [date, setDate] = useState(() => {
    const d = new Date(article.date);
    return Number.isNaN(d.getTime()) ? "" : d.toISOString().split("T")[0];
  });
  const [error, setError] = useState<string | null>(null);

  const feedItems = feeds.map((f) => ({ value: String(f.id), label: f.name }));

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
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

  const createdAtFormatted = new Date(article.createdAt).toLocaleString();

  return (
    <form onSubmit={handleSubmit} className="space-y-6 max-w-xl">
      {error && (
        <div className="rounded-md bg-destructive/15 p-3 text-sm text-destructive font-medium">
          {error}
        </div>
      )}

      <div className="space-y-2">
        <Label htmlFor="article-name">{t("name")}</Label>
        <Input id="article-name" value={name} onChange={(e) => setName(e.target.value)} required />
      </div>

      <div className="space-y-2">
        <Label htmlFor="article-feed">{t("feed")}</Label>
        <Select
          items={feedItems}
          value={String(feedId)}
          onValueChange={(val) => setFeedId(Number(val))}
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
        <Button type="submit" disabled={isPending} className="w-full sm:w-auto">
          {isPending ? t("save") + "..." : t("save")}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={isPending || reloading}
          onClick={runReload}
          className="w-full sm:w-auto"
        >
          {t("reloadNow")}
        </Button>
      </div>
    </form>
  );
}
