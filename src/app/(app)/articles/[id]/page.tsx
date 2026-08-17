import { connection } from "next/server";

import { ArticleDetailSection } from "@/components/articles/article-detail-section";
import { getArticle, getBlockTree } from "@/lib/articles/queries";
import { listFeeds } from "@/lib/feeds/actions";
import { parseListParams } from "@/lib/crud/params";

/**
 * The instant-render-no-fallback migration (see
 * `src/app/(app)/settings/page.tsx`): this page body awaits nothing, so it
 * cannot suspend and `loading.tsx` -- deleted along with this rewrite -- is
 * unreachable.
 *
 * Three things this page used to await, and where each went:
 * - `await requireUser()` is gone entirely. `getArticle()` already scopes its
 *   join to `currentUserId()`, so this page's own call was redundant with it.
 * - `await getArticle(id)`, which used to decide a real `notFound()`, is now
 *   a promise handed to `<ArticleDetailSection>` and consumed with `use()`
 *   there. **This route therefore no longer answers 404** -- a missing id, a
 *   non-numeric id, and an article owned by someone else all render the same
 *   not-found state once the promise resolves to `null`, rather than
 *   truncating a 200 the way calling `notFound()` after the shell has
 *   flushed would (see CLAUDE.md's `connection()`/detail-route rules, and
 *   `ArticleDetailResolved`'s own doc comment). This was a deliberate,
 *   explicitly-approved trade-off, not an oversight.
 * - `await getTranslations("articles")` is gone; `<ArticleDetailSection>`
 *   reads `useTranslations("articles")` client-side once the article is
 *   known.
 *
 * `feedsPromise`/`blockTreePromise` were already unawaited promises before
 * this rewrite and stay that way -- `getBlockTree()` verifies ownership
 * itself and resolves to `[]` for an id that is not this user's, so it needs
 * no gating here either.
 */
export default function ArticleDetailPage({ params }: { params: Promise<{ id: string }> }) {
  /**
   * Opt this route out of prerendering -- **called, not awaited**, exactly as
   * `SettingsPage`/`AccountPage` do: `getArticle()` below is never awaited by
   * this page body, so there is no other awaited Dynamic API left here to do
   * this job.
   */
  connection();

  // Not awaited: chained onto the `params` promise instead, so this page
  // body still awaits nothing. `getArticle()` decides the not-found state
  // now, not a real 404, so it no longer needs to sit ahead of everything
  // else.
  const articlePromise = params.then(({ id }) => {
    const parsed = Number.parseInt(id, 10);
    return Number.isNaN(parsed) ? null : getArticle(parsed);
  });
  const feedsPromise = listFeeds(parseListParams({ pageSize: "100" })).then((res) => res.rows);
  const blockTreePromise = params.then(({ id }) => {
    const parsed = Number.parseInt(id, 10);
    return Number.isNaN(parsed) ? [] : getBlockTree(parsed);
  });

  return (
    <div className="space-y-8">
      <ArticleDetailSection
        articlePromise={articlePromise}
        feedsPromise={feedsPromise}
        blockTreePromise={blockTreePromise}
      />
    </div>
  );
}
