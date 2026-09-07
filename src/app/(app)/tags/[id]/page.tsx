import { connection } from "next/server";

import { EditTagSection } from "@/components/tags/edit-tag-section";
import { getTag } from "@/lib/tags/queries";

/**
 * The instant-render-no-fallback migration (see
 * `src/app/(app)/settings/page.tsx`): this page body awaits nothing, so it
 * cannot suspend and `loading.tsx` -- deleted along with this rewrite -- is
 * unreachable.
 *
 * `await requireUser()` is gone entirely -- `getTag()` already scopes its
 * read to `tags.userId = session.id`, so this page's own call was redundant
 * with it. `await getTag(id)`, which used to decide a real `notFound()`, is
 * now a promise handed to `<EditTagSection>` and consumed with `use()`
 * there. **This route therefore no longer answers 404** -- a missing id, a
 * non-numeric id, and a tag owned by someone else all render the same
 * not-found state once the promise resolves to `null`, rather than
 * truncating a 200 the way calling `notFound()` after the shell has flushed
 * would. This was a deliberate, explicitly-approved trade-off, not an
 * oversight. `await getTranslations("tags")` is gone too; `<EditTagSection>`
 * reads `useTranslations("tags")` client-side once the tag is known.
 */
export default function EditTagPage({ params }: { params: Promise<{ id: string }> }) {
  /**
   * Opt this route out of prerendering -- **called, not awaited**, exactly as
   * `SettingsPage`/`AccountPage` do: `getTag()` below is never awaited by
   * this page body, so there is no other awaited Dynamic API left here to do
   * this job.
   */
  connection();

  // Not awaited: chained onto the `params` promise instead, so this page
  // body still awaits nothing.
  const tagPromise = params.then(({ id }) => {
    const parsed = parseInt(id, 10);
    return Number.isNaN(parsed) ? null : getTag(parsed);
  });

  return (
    <div className="space-y-4">
      <EditTagSection tagPromise={tagPromise} />
    </div>
  );
}
