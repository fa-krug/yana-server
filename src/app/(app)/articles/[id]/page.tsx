import { Suspense } from "react";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";

import { ArticleForm } from "@/components/articles/article-form";
import { BlockTree } from "@/components/articles/block-tree";
import { TableSkeleton } from "@/components/data-skeleton";
import { getArticle, getBlockTree } from "@/lib/articles/queries";
import { requireUser } from "@/lib/auth/session";
import { parseListParams } from "@/lib/crud/params";
import { listFeeds } from "@/lib/feeds/actions";

async function GeneralSection({ id }: { id: number }) {
  const [article, feedsRes] = await Promise.all([
    getArticle(id),
    listFeeds(parseListParams({ pageSize: "100" })),
  ]);

  if (!article) {
    notFound();
  }

  return <ArticleForm article={article} feeds={feedsRes.rows} />;
}

async function ContentSection({ id }: { id: number }) {
  const nodes = await getBlockTree(id);
  return <BlockTree nodes={nodes} />;
}

export default async function ArticleDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requireUser();

  const id = Number.parseInt((await params).id, 10);
  if (Number.isNaN(id)) {
    notFound();
  }

  const t = await getTranslations("articles");

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-semibold">{t("editTitle")}</h1>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold">{t("general")}</h2>
        <Suspense fallback={<TableSkeleton rows={4} columns={1} />}>
          <GeneralSection id={id} />
        </Suspense>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold">{t("content")}</h2>
        <Suspense fallback={<TableSkeleton rows={8} columns={1} />}>
          <ContentSection id={id} />
        </Suspense>
      </section>
    </div>
  );
}
