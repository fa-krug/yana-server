"use client";

import { Suspense, type ReactNode } from "react";

import { useListParams } from "@/components/crud/use-list-params";
import { PaginationPlaceholder } from "@/components/crud/pagination";
import { TableRowsSkeleton } from "@/components/data-skeleton";
import { ArticlesTableShell } from "@/components/articles/articles-table";

/**
 * The two `<Suspense>` boundaries around the articles table body and
 * pagination, each reset by the current list params -- previously computed
 * in `ArticlesPage` itself via `JSON.stringify(await searchParams)`.
 *
 * `ArticlesPage` cannot await `searchParams` any more (see its own doc
 * comment), so it cannot compute that key synchronously either. Reading it
 * here instead -- via `useListParams()`, the same `parseListParams()` the
 * server side uses, just sourced from the URL client-side -- gives an
 * identical key without the page body awaiting anything. See
 * `FeedsListRegion` for the identical reasoning, including why a changing
 * `key` (rather than a stable one) is what this migration still needs given
 * Next's default of preserving a suspended boundary's previous content
 * across a transition.
 *
 * `tableBody`/`pagination` are Server Component elements (`<ArticlesBody>`,
 * `<ArticlesPagination>`) that `ArticlesPage` constructs and hands down as
 * props -- a Client Component may render a Server Component passed to it
 * this way, the same composition `<ListSelectionProvider>` already relies on
 * for `<ArticlesTableShell>`'s children.
 */
export function ArticlesListRegion({
  tableBody,
  pagination,
}: {
  tableBody: ReactNode;
  pagination: ReactNode;
}) {
  const { params } = useListParams();
  const resetKey = JSON.stringify(params);

  return (
    <>
      {/* See src/app/(app)/tags/page.tsx for why the shell takes `resetKey`
          rather than a `key`, and why only the inner Suspense is keyed. */}
      <ArticlesTableShell resetKey={resetKey}>
        <Suspense key={resetKey} fallback={<TableRowsSkeleton columns={5} />}>
          {tableBody}
        </Suspense>
      </ArticlesTableShell>

      <Suspense key={resetKey} fallback={<PaginationPlaceholder />}>
        {pagination}
      </Suspense>
    </>
  );
}
