import { getTranslations } from "next-intl/server";

import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * The route's own fallback, replacing `(app)/loading.tsx`'s generic
 * `<TableSkeleton>` for this segment specifically. `EditUserPage` awaits
 * `requireAdmin()` and then its row before returning any JSX at all -- see the
 * page's own comment and CLAUDE.md's "detail route awaits its row at the top
 * and has no data region at all" rule: `notFound()` can only produce a real 404
 * while the response is still open, so this page cannot wrap the read in a
 * `<Suspense>` the way a list page does. Without this file, the whole time that
 * gate and lookup take shows the unrelated generic fallback instead of anything
 * resembling this page.
 *
 * The title (`t("editTitle")`) is static -- no record data baked in -- so it
 * costs nothing to show for real via `getTranslations`. The form and delete
 * section below it both depend on the fetched user, so they are placeholder
 * bars shaped like `<UserForm>`'s four fields and `<DeleteUserSection>`'s small
 * card.
 */
export default async function Loading() {
  const t = await getTranslations("users");

  return (
    <div className="max-w-2xl space-y-6" aria-busy="true" aria-live="polite">
      <h1 className="text-2xl font-semibold">{t("editTitle")}</h1>

      {/* UserForm: first name, last name, email, role select */}
      <div className="space-y-4">
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
      </div>

      <Separator />

      {/* DeleteUserSection: a small destructive-action card */}
      <div className="space-y-3 rounded-lg border p-4">
        <Skeleton className="h-5 w-1/3" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-9 w-24" />
      </div>
    </div>
  );
}
