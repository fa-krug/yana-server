"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Suspense, use, useState, useTransition } from "react";
import { toast } from "sonner";
import { CopyIcon } from "lucide-react";

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
import { useTrackRun } from "@/components/jobs/active-runs-context";
import { reloadArticles, updateArticle } from "@/lib/articles/actions";
import { attemptCall } from "@/lib/attempt";
import type { Article } from "@/lib/db/schema";

export type ArticleFeed = { id: number; name: string };

/**
 * The columns this form renders -- not the whole `Article` row, which also
 * carries `plainText` (the largest column on the table,
 * per the FTS bullet in CLAUDE.md) and no longer carries the joined `Feed`
 * either, since nothing here ever read it (the feed *picker* is populated
 * from `listFeeds()`, a separate read; see `ArticleFeed` above). Projected
 * out of `getArticle()`'s full row in `/articles/[id]/page.tsx`'s own
 * `.then()`, the same pattern `/users/[id]/page.tsx` uses for `UserRecord` --
 * `getArticle()` itself stays the full row because it is also a
 * general-purpose read other code (and its own tests) depend on.
 */
export type ArticleDetailRow = Pick<
  Article,
  "id" | "name" | "identifier" | "feedId" | "date" | "createdAt"
>;

/**
 * `navigator.clipboard` exists only in a secure context, so a self-hosted
 * instance reached over plain HTTP on a LAN -- which this project supports --
 * has no clipboard API at all, and the button would silently do nothing. The
 * `execCommand` path is deprecated but is what still works there.
 */
async function writeToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // No clipboard API, or permission refused -- fall through to the fallback.
  }

  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const copied = document.execCommand("copy");
    area.remove();
    return copied;
  } catch {
    return false;
  }
}

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
  article?: ArticleDetailRow;
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
  // Not editable state: `feedId` is half the key the aggregate handler looks
  // an article up by (`(feedId, identifier)`), so `updateArticle()` forbids
  // changing it -- see the guard in `@/lib/articles/actions`. The picker below
  // renders the current feed disabled, for the same reason `createdAt` is
  // shown but not editable.
  const feedId = article?.feedId;
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
      // `feedId` is deliberately not part of this payload -- the picker below
      // is disabled and never changes it, and `updateArticle()` would refuse
      // it anyway (see the note beside the `feedId` state above).
      const res = await updateArticle(article.id, {
        name,
        date: parsedDate,
      });

      if (!res.ok) {
        // `errorKey` is a catalog key under this component's own `articles`
        // namespace (see `UpdateArticleErrorKey` in `@/lib/articles/actions`)
        // and always wins over `error`, which is either zod's own English
        // validation message or a plain "not found" -- never something to
        // render verbatim into a UI that might be showing German.
        const message = res.errorKey ? t(res.errorKey) : t("saveFailed");
        setError(message);
        toast.error(message);
        return;
      }

      toast.success(t("saved"));
      router.refresh();
    });
  };

  const createdAtFormatted = article ? new Date(article.createdAt).toLocaleString() : "";

  // `articles.identifier` -- the URL every aggregator stores as the article's
  // source (a watch URL for YouTube, a permalink for Reddit, the entry link
  // for RSS). Empty only when a feed entry carried no link at all.
  const sourceUrl = article?.identifier ?? "";

  async function copySourceUrl() {
    if (!sourceUrl) return;
    if (await writeToClipboard(sourceUrl)) {
      toast.success(t("sourceCopied"));
    } else {
      toast.error(t("sourceCopyFailed"));
    }
  }

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
          // Always disabled, not just while `busy`: `updateArticle()` forbids
          // changing `feedId` (see the note above), so this control has
          // nothing to submit -- offering it enabled would be a control that
          // always errors. `feedNote` below says why.
          disabled
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
        <p className="text-xs text-muted-foreground">{t("feedNote")}</p>
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
        <Label htmlFor="article-source">{t("source")}</Label>
        {/*
          A button rather than a read-only input: pressing it copies, and a
          button is labelable, so the `<Label htmlFor>` above still gives it
          an accessible name. Disabled while pending and when the article
          carries no link, which is also the `pending` chassis's state.
        */}
        <button
          id="article-source"
          type="button"
          onClick={copySourceUrl}
          disabled={busy || !sourceUrl}
          title={sourceUrl || undefined}
          className="flex h-8 w-full min-w-0 items-center gap-2 rounded-lg border border-input bg-transparent px-2.5 py-1 text-left text-base transition-colors outline-none hover:bg-accent focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 md:text-sm dark:bg-input/30 dark:disabled:bg-input/80"
        >
          <span className="truncate">{sourceUrl}</span>
          <CopyIcon className="ml-auto size-4 shrink-0 text-muted-foreground" aria-hidden />
        </button>
        <p className="text-xs text-muted-foreground">{t("sourceNote")}</p>
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
  article: ArticleDetailRow;
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
  article: ArticleDetailRow;
  feedsPromise: Promise<ArticleFeed[]>;
}) {
  return (
    <Suspense fallback={<ArticleForm article={article} pending />}>
      <ArticleFormResolved article={article} feedsPromise={feedsPromise} />
    </Suspense>
  );
}
