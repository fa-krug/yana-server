import { connection } from "next/server";

import { NewTagTitle } from "@/components/tags/new-tag-title";
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
 * gone too, replaced by `<NewTagTitle>` -- a client component reading
 * `useTranslations("tags")` off the `NextIntlClientProvider` the root layout
 * already renders. See `SettingsTitle`'s own comment for why the namespace is
 * a literal rather than a generic prop.
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
      <NewTagTitle />
      {/* No data region, so no Suspense boundary: the form starts empty. */}
      <TagForm />
    </div>
  );
}
