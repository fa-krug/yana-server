import { connection } from "next/server";

import { EditFeedSection } from "@/components/feeds/edit-feed-section";
import { capabilitiesFor, getFeed } from "@/lib/feeds/actions";
import { listTags } from "@/lib/tags/queries";

/**
 * The instant-render-no-fallback migration (see
 * `src/app/(app)/settings/page.tsx`): this page body awaits nothing, so it
 * cannot suspend and `loading.tsx` -- deleted along with this rewrite -- is
 * unreachable.
 *
 * Three things this page used to await, and where each went:
 * - `await requireUser()` is gone entirely. `getFeed()` already scopes its
 *   read to `currentUserId()`, so this page's own call was redundant with it.
 * - `await getFeed(id)`, which used to decide a real `notFound()`, is now a
 *   promise handed to `<EditFeedSection>` and consumed with `use()` there.
 *   **This route therefore no longer answers 404** -- a missing id, a
 *   non-numeric id, and a feed owned by someone else all render the same
 *   not-found state once the promise resolves to `null`, rather than
 *   truncating a 200 the way calling `notFound()` after the shell has
 *   flushed would (see CLAUDE.md's `connection()`/detail-route rules, and
 *   the doc comment on `EditFeedResolved`). This was a deliberate,
 *   explicitly-approved trade-off, not an oversight.
 * - `await getTranslations("feeds")` is gone; `<EditFeedSection>` reads
 *   `useTranslations("feeds")` client-side instead, once the feed is known.
 *
 * `capabilitiesFor()`/`listTags()` were already unawaited promises before
 * this rewrite and stay that way.
 */
export default function EditFeedPage({ params }: { params: Promise<{ id: string }> }) {
  /**
   * Opt this route out of prerendering -- **called, not awaited**, exactly as
   * `SettingsPage`/`AccountPage` do: `getFeed()` below is never awaited by
   * this page body, so there is no other awaited Dynamic API left here to do
   * this job.
   */
  connection();

  // Not awaited: chained onto the `params` promise instead, so this page
  // body still awaits nothing. `getFeed()` decides the not-found state now,
  // not a real 404, so it no longer needs to sit ahead of everything else.
  const feedPromise = params.then(({ id }) => {
    const parsed = Number(id);
    return Number.isNaN(parsed) ? null : getFeed(parsed);
  });
  const capabilitiesPromise = capabilitiesFor();
  // Fetch all tags (assume max 1000 is enough for the form)
  const allTagsPromise = listTags({
    q: "",
    page: 1,
    pageSize: 1000,
    sort: "name",
    dir: "asc",
    filters: {},
  }).then((res) => res.rows);

  return (
    <div className="space-y-4">
      <EditFeedSection
        feedPromise={feedPromise}
        capabilitiesPromise={capabilitiesPromise}
        allTagsPromise={allTagsPromise}
      />
    </div>
  );
}
