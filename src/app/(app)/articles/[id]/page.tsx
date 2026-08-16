import { Suspense } from "react";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";

import { ArticleFormSection } from "@/components/articles/article-form";
import { SetBreadcrumbTitle } from "@/components/breadcrumb-title";
import { BlockTree } from "@/components/articles/block-tree";
import { TableSkeleton } from "@/components/data-skeleton";
import { getArticle, getBlockTree } from "@/lib/articles/queries";
import { requireUser } from "@/lib/auth/session";
import type { BlockNode } from "@/lib/blocks/tree";
import { parseListParams } from "@/lib/crud/params";
import { listFeeds } from "@/lib/feeds/actions";

async function ContentSection({ blockTreePromise }: { blockTreePromise: Promise<BlockNode[]> }) {
  const nodes = await blockTreePromise;
  return <BlockTree nodes={nodes} />;
}

export default async function ArticleDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requireUser();

  const id = Number.parseInt((await params).id, 10);
  if (Number.isNaN(id)) {
    notFound();
  }

  /**
   * Read here, awaited, rather than inside a `<Suspense>` boundary -- the 404
   * for an article that does not exist (or belongs to someone else --
   * `getArticle()` scopes to `currentUserId()`) depends on this row, and
   * `notFound()` can only produce a real 404 while the response status is
   * still open. This used to live inside `GeneralSection`, itself wrapped in
   * a `<Suspense>` boundary -- which, per CLAUDE.md, would have truncated a
   * 200 instead of answering 404 once the shell had already flushed.
   */
  const article = await getArticle(id);
  if (!article) {
    notFound();
  }

  const t = await getTranslations("articles");

  // Unawaited on purpose: neither decides the response status, so both
  // stream in behind the article's own `<Suspense>`/content boundaries
  // rather than lengthening the one indexed read above.
  const feedsPromise = listFeeds(parseListParams({ pageSize: "100" })).then((res) => res.rows);
  const blockTreePromise = getBlockTree(id);

  return (
    <div className="space-y-8">
      <SetBreadcrumbTitle title={article.name} />
      <h1 className="text-2xl font-semibold">{t("editTitle")}</h1>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold">{t("general")}</h2>
        <ArticleFormSection article={article} feedsPromise={feedsPromise} />
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold">{t("content")}</h2>
        <Suspense fallback={<TableSkeleton rows={8} columns={1} />}>
          <ContentSection blockTreePromise={blockTreePromise} />
        </Suspense>
      </section>
    </div>
  );
}
