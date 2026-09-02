import { connection } from "next/server";

import { NewFeedForm } from "@/components/feeds/feed-form";
import { capabilitiesFor } from "@/lib/feeds/actions";
import { listTags } from "@/lib/tags/queries";

/**
 * The instant-render-no-fallback migration (see
 * `src/app/(app)/settings/page.tsx`): this page body awaits nothing, so it
 * cannot suspend and `loading.tsx` -- deleted along with this rewrite -- is
 * unreachable.
 *
 * Two things this page used to await, and where each went:
 * - `await requireUser()` is gone from here entirely, the same call as
 *   `/feeds`'s own page removed (see its doc comment). `capabilitiesFor()`
 *   already scopes through `getSettings()` -> `currentUserId()` ->
 *   `requireUser()`, and `listTags()` already awaits `requireUser()` itself
 *   and scopes every row to `session.id` -- this page's own call was
 *   redundant with both, never the only thing standing between another
 *   user's tags and this page.
 * - `await getTranslations("feeds")` is gone, along with the page `<h1>` it
 *   produced: the breadcrumb already names the page, so the per-page heading
 *   was removed everywhere.
 */
export default function NewFeedPage() {
  /**
   * Opt this route out of prerendering -- **called, not awaited**. Neither
   * `capabilitiesFor()` nor `listTags()` below is awaited by this page body
   * (both are handed straight to `<NewFeedForm>` as promises), so with
   * `await requireUser()` gone there is no other awaited Dynamic API left
   * here to do this job. See `SettingsPage`'s identical comment (and
   * CLAUDE.md's `connection()` bullet) for why calling it, unawaited, is
   * enough today -- and the `cacheComponents` precondition that fact rests
   * on.
   */
  connection();

  // Not awaited: handed to `<NewFeedForm>`, whose real form chassis renders
  // immediately (disabled, per its own `pending` fallback) and fills in the
  // capability-derived filtering and the tag list once these resolve.
  // Awaiting either here is what used to make the whole page suspend behind
  // a 1000-row `listTags()` call.
  const capabilities = capabilitiesFor();
  const allTags = listTags({
    q: "",
    page: 1,
    pageSize: 1000,
    sort: "name",
    dir: "asc",
    filters: {},
  }).then((result) => result.rows);

  return (
    <div className="space-y-4">
      <NewFeedForm capabilitiesPromise={capabilities} allTagsPromise={allTags} />
    </div>
  );
}
