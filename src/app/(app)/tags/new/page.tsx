import { connection } from "next/server";

import { TagForm } from "@/components/tags/tag-form";

/**
 * The instant-render-no-fallback migration (see
 * `src/app/(app)/settings/page.tsx`): this page body awaits nothing, so it
 * cannot suspend and `loading.tsx` -- deleted along with this rewrite -- is
 * unreachable.
 *
 * `await requireUser()` is gone entirely: this page reaches no data query of
 * its own -- `<TagForm>` starts empty and `createTag()` (invoked only on
 * submit, never during render) scopes and authorizes itself through
 * `currentUserId()` -- so the gate here was never the only thing standing
 * between an unauthenticated request and this page; the `(app)` layout's own
 * `requireUser()` already covers that. `await getTranslations("tags")` is
 * gone too, along with the page `<h1>` it produced: the breadcrumb already
 * names the page, so the per-page heading was removed everywhere.
 */
export default function NewTagPage() {
  /**
   * Opt this route out of prerendering -- **called, not awaited**. This page
   * reaches no data query of its own, so with `await requireUser()` gone
   * there is no other Dynamic API call left here to do this job. See
   * `SettingsPage`'s identical comment (and CLAUDE.md's `connection()`
   * bullet) for why calling it, unawaited, is enough today -- and the
   * `cacheComponents` precondition that fact rests on.
   */
  connection();

  return (
    <div className="space-y-4">
      {/* No data region, so no Suspense boundary: the form starts empty. */}
      <TagForm />
    </div>
  );
}
