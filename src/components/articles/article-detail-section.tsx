"use client";

import { Suspense, use } from "react";
import { useTranslations } from "next-intl";

import { BlockTree } from "@/components/articles/block-tree";
import { SetBreadcrumbTitle } from "@/components/breadcrumb-title";
import { RecordNotFound } from "@/components/record-not-found";
import { TableSkeleton } from "@/components/data-skeleton";
import type { BlockNode } from "@/lib/blocks/tree";
import {
  ArticleForm,
  ArticleFormSection,
  type ArticleDetailRow,
  type ArticleFeed,
} from "./article-form";

/** Suspends on the block tree alone; `ContentSection` in the found path. */
function ContentSection({ blockTreePromise }: { blockTreePromise: Promise<BlockNode[]> }) {
  const nodes = use(blockTreePromise);
  return <BlockTree nodes={nodes} />;
}

/**
 * Calls `use()` on the article promise `/articles/[id]/page.tsx` hands down;
 * suspends until it settles; renders either the real detail view or the
 * not-found state.
 *
 * `articlePromise` resolves to `null` for a nonexistent id, a non-numeric id,
 * or an article owned by someone else -- `getArticle()` already scopes its
 * join to `feeds.userId = currentUserId()`, so this component cannot tell
 * those apart and does not try to (see `RecordNotFound`'s own comment).
 */
function ArticleDetailResolved({
  articlePromise,
  feedsPromise,
  blockTreePromise,
}: {
  articlePromise: Promise<ArticleDetailRow | null>;
  feedsPromise: Promise<ArticleFeed[]>;
  blockTreePromise: Promise<BlockNode[]>;
}) {
  const article = use(articlePromise);
  const t = useTranslations("articles");

  if (!article) {
    return <RecordNotFound />;
  }

  return (
    <>
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
    </>
  );
}

/**
 * What `/articles/[id]/page.tsx` renders. The title (`t("editTitle")`)
 * carries no record data, so the fallback only needs the real
 * `<ArticleForm pending />` chassis for the general section -- the content
 * section has no known article at this point either, so it stays absent
 * (rather than a placeholder) until the whole thing resolves, the same way
 * `EditUserSection`'s fallback omits `<DeleteUserSection>`. This replaces
 * `/articles/[id]/loading.tsx`, deleted along with this component: the page
 * body that renders this awaits nothing, so that route-level fallback is
 * unreachable now (see `src/app/(app)/settings/page.tsx`'s doc comment for
 * the migration this belongs to).
 */
export function ArticleDetailSection({
  articlePromise,
  feedsPromise,
  blockTreePromise,
}: {
  articlePromise: Promise<ArticleDetailRow | null>;
  feedsPromise: Promise<ArticleFeed[]>;
  blockTreePromise: Promise<BlockNode[]>;
}) {
  return (
    <Suspense fallback={<ArticleForm pending />}>
      <ArticleDetailResolved
        articlePromise={articlePromise}
        feedsPromise={feedsPromise}
        blockTreePromise={blockTreePromise}
      />
    </Suspense>
  );
}
