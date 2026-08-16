import { Skeleton } from "@/components/ui/skeleton";
import { FeedForm } from "@/components/feeds/feed-form";

/**
 * The route's own fallback, replacing `(app)/loading.tsx`'s generic
 * `<TableSkeleton>` for this segment specifically. `EditFeedPage` awaits
 * `requireUser()` and then `getFeed()` before returning any JSX at all --
 * `notFound()` can only produce a real 404 while the response is still open,
 * so that read cannot move into a `<Suspense>` boundary here (see the page's
 * own comment and CLAUDE.md's "detail route awaits its row at the top"
 * rule). Without this file a navigation to `/feeds/[id]` shows the group's
 * title-less, form-less fallback for however long all of that takes.
 *
 * The real title is `t("editTitle", { name: feed.name })` -- it needs the
 * fetched feed's name, which isn't available yet, so a `<Skeleton>` bar
 * stands in for the `<h1>` deliberately -- this is the one genuine unknown,
 * and it stays a skeleton rather than being "finished" into real text.
 *
 * Below it, `<FeedForm pending />` renders the real form chassis instead of
 * hand-placed bars: every label, every disabled control, both action
 * buttons. There is no known feed yet at this point (contrast the page's
 * own `<EditFeedForm>` fallback, which already has the feed and only
 * disables while capabilities/tags stream in), so every field is blank as
 * well as disabled.
 */
export default function Loading() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-8 w-1/3" />
      <FeedForm pending />
    </div>
  );
}
