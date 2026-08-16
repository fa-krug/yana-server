import { getTranslations } from "next-intl/server";

import { TagForm } from "@/components/tags/tag-form";

/**
 * The route's own fallback, replacing `(app)/loading.tsx`'s generic
 * `<TableSkeleton>` for this segment specifically. `EditTagPage` awaits
 * `requireUser()` and then its row before returning any JSX -- CLAUDE.md's
 * "detail route awaits its row at the top and has no data region at all"
 * rule: `notFound()` can only produce a real 404 while the response is still
 * open, so the read cannot sit inside a `<Suspense>` boundary here.
 *
 * The title (`t("editTitle")`) is static, so it renders for real via
 * `getTranslations` -- cheap, no DB access. Below it, `<TagForm pending />`
 * renders the real chassis (name input, colour picker, both action buttons)
 * disabled, instead of two hand-placed bars that had to be kept in visual
 * sync with the form by hand.
 */
export default async function Loading() {
  const t = await getTranslations("tags");

  return (
    <div className="space-y-4" aria-busy="true" aria-live="polite">
      <h1 className="text-2xl font-semibold">{t("editTitle")}</h1>
      <TagForm pending />
    </div>
  );
}
