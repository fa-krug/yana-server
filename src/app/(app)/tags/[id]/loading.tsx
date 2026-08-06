import { getTranslations } from "next-intl/server";

import { Skeleton } from "@/components/ui/skeleton";

/**
 * The route's own fallback, replacing `(app)/loading.tsx`'s generic
 * `<TableSkeleton>` for this segment specifically. `EditTagPage` awaits
 * `requireUser()` and then its row before returning any JSX -- CLAUDE.md's
 * "detail route awaits its row at the top and has no data region at all"
 * rule: `notFound()` can only produce a real 404 while the response is still
 * open, so the read cannot sit inside a `<Suspense>` boundary here.
 *
 * The title (`t("editTitle")`) is static, so it renders for real via
 * `getTranslations` -- cheap, no DB access. `<TagForm>` itself is small (name
 * + color), so the placeholder below it is scaled down to match rather than
 * reusing the users page's four-field block.
 */
export default async function Loading() {
  const t = await getTranslations("tags");

  return (
    <div className="space-y-4" aria-busy="true" aria-live="polite">
      <h1 className="text-2xl font-semibold">{t("editTitle")}</h1>

      {/* TagForm: name input, color picker */}
      <div className="space-y-4">
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
      </div>
    </div>
  );
}
