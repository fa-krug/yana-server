import { getTranslations } from "next-intl/server";

import { TableSkeleton } from "@/components/data-skeleton";

/**
 * The route's own fallback, replacing `(app)/loading.tsx`'s generic
 * `<TableSkeleton>` for this segment specifically. `ArticleDetailPage` awaits
 * `requireUser()` before returning any JSX, so without this file that top-level
 * await -- not just the page's own `<Suspense>` boundaries below it -- shows the
 * group's unrelated fallback.
 *
 * This mirrors what the page already renders synchronously (its static
 * `t("editTitle")` title and the two section headings) plus both of the
 * page's own `<Suspense>` fallbacks verbatim, hoisted here so the whole shape
 * is available before `requireUser()` resolves too.
 */
export default async function Loading() {
  const t = await getTranslations("articles");

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-semibold">{t("editTitle")}</h1>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold">{t("general")}</h2>
        <TableSkeleton rows={4} columns={1} />
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold">{t("content")}</h2>
        <TableSkeleton rows={8} columns={1} />
      </section>
    </div>
  );
}
