import { Skeleton } from "@/components/ui/skeleton";

/**
 * The route's own fallback, replacing `(app)/loading.tsx`'s generic
 * `<TableSkeleton>` for this segment specifically. `EditFeedPage` awaits
 * `requireUser()`, `getFeed()`, `capabilitiesFor()` and `listTags()` before
 * returning any JSX at all, so without this file a navigation to `/feeds/[id]`
 * shows the group's title-less, form-less fallback for however long all of
 * that takes.
 *
 * The real title is `t("editTitle", { name: feed.name })` -- it needs the
 * fetched feed's name, which isn't available yet, so a `<Skeleton>` bar stands
 * in for the `<h1>` rather than rendering translated text around a
 * placeholder name. Below it, a handful of field-shaped bars approximate
 * `<FeedForm>`'s shape (aggregator picker, name, identifier, tags, the
 * interval/concurrency pair, an options block, then actions) -- more of them
 * than a simpler form's skeleton would need, since this is one of the larger
 * forms in the app, but not attempting to be pixel-perfect.
 */
export default function Loading() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-8 w-1/3" />

      <div className="max-w-2xl space-y-6">
        <div className="grid gap-2">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-9 w-full" />
        </div>

        <div className="grid gap-2">
          <Skeleton className="h-4 w-16" />
          <Skeleton className="h-9 w-full" />
        </div>

        <div className="grid gap-2">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-9 w-full" />
        </div>

        <div className="grid gap-2">
          <Skeleton className="h-4 w-16" />
          <Skeleton className="h-9 w-full" />
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="grid gap-2">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-9 w-full" />
          </div>
          <div className="grid gap-2">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-9 w-full" />
          </div>
        </div>

        <div className="space-y-4 rounded-lg border p-4 bg-muted/20">
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
        </div>

        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          <Skeleton className="h-9 w-full sm:w-24" />
          <Skeleton className="h-9 w-full sm:w-32" />
          <Skeleton className="h-9 w-full sm:w-24" />
        </div>
      </div>
    </div>
  );
}
