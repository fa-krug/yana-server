import { getTranslations } from "next-intl/server";

import { TagForm } from "@/components/tags/tag-form";

/**
 * This route's own fallback -- shown by Next while the RSC payload for a
 * **client-side soft navigation** into `/tags/new` (e.g. clicking "Add tag"
 * from the tags list) is still in flight over the network. `NewTagPage` has
 * no data query of its own -- `requireUser()` and `getTranslations()` are its
 * only awaits -- but that per-request-cached read is still enough to suspend
 * the page function as one unit during a soft navigation, and without this
 * file the route fell through to `(app)/loading.tsx`'s generic
 * `<TableSkeleton>` -- a table shape on a page that is a two-field form.
 *
 * It renders the **real form chassis in its pending state**: `<TagForm
 * pending />`, the same component `NewTagPage` itself renders once the
 * navigation lands. The name input and the colour picker are on screen,
 * disabled, from the very first frame.
 */
export default async function Loading() {
  const t = await getTranslations("tags");

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">{t("newTitle")}</h1>
      <TagForm pending />
    </div>
  );
}
