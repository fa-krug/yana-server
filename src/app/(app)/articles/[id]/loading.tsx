import { getTranslations } from "next-intl/server";

import { ArticleForm } from "@/components/articles/article-form";
import { TableSkeleton } from "@/components/data-skeleton";

/**
 * The route's own fallback, replacing `(app)/loading.tsx`'s generic
 * `<TableSkeleton>` for this segment specifically. `ArticleDetailPage` awaits
 * `requireUser()` and then `getArticle()` before returning any JSX at all --
 * `notFound()` can only produce a real 404 while the response is still open,
 * so that read cannot move into a `<Suspense>` boundary here (see the page's
 * own comment and CLAUDE.md's "detail route awaits its row at the top" rule).
 * Without this file, the whole time that takes shows the group's unrelated
 * fallback instead of anything resembling this page.
 *
 * The title (`t("editTitle")`) is static -- no record data baked in -- so it
 * costs nothing to render for real via `getTranslations`. Below it, the
 * "General" section renders the real `<ArticleForm pending />` chassis --
 * every label, every disabled control -- instead of hand-placed bars; there
 * is no known article yet at this point, so every field is blank as well as
 * disabled (contrast the page's own `<ArticleFormSection>` fallback, which
 * already has the article and only disables the feed picker while it
 * streams in). The "Content" section keeps its existing `<TableSkeleton>`:
 * a block tree has no form shape to mirror, so there is nothing more
 * specific to render for it.
 */
export default async function Loading() {
  const t = await getTranslations("articles");

  return (
    <div className="space-y-8" aria-busy="true" aria-live="polite">
      <h1 className="text-2xl font-semibold">{t("editTitle")}</h1>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold">{t("general")}</h2>
        <ArticleForm pending />
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold">{t("content")}</h2>
        <TableSkeleton rows={8} columns={1} />
      </section>
    </div>
  );
}
