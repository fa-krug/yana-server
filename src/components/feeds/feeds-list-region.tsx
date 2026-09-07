"use client";

import { Suspense, type ReactNode } from "react";

import { useListParams } from "@/components/crud/use-list-params";
import { PaginationPlaceholder } from "@/components/crud/pagination";
import { TableRowsSkeleton } from "@/components/data-skeleton";
import { FeedsTableShell } from "@/components/feeds/feeds-table";

/**
 * The two `<Suspense>` boundaries around the feeds table body and pagination,
 * each reset by the current list params -- previously computed in
 * `FeedsPage` itself via `JSON.stringify(await searchParams)`.
 *
 * `FeedsPage` cannot await `searchParams` any more (see its own doc comment),
 * so it cannot compute that key synchronously either. Reading it here instead
 * -- via `useListParams()`, the same `parseListParams()` the server side
 * uses, just sourced from the URL client-side -- gives an identical key
 * without the page body awaiting anything. Client-side navigations here are
 * already wrapped in a React transition by Next's router (`router.replace`
 * from `<SearchFilterBar>`, `<Link>` from `<Pagination>`), which by default
 * keeps a suspended boundary's *previous* content on screen rather than
 * showing its fallback again -- exactly what changing this `key` overrides,
 * the same reason `src/app/(app)/tags/page.tsx` documents for its own
 * (server-computed) key.
 *
 * `tableBody`/`pagination` are Server Component elements (`<FeedsBody>`,
 * `<FeedsPagination>`) that `FeedsPage` constructs and hands down as props --
 * a Client Component may render a Server Component passed to it this way,
 * the same composition `<ListSelectionProvider>` already relies on for
 * `<FeedsTableShell>`'s children.
 */
export function FeedsListRegion({
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
      <FeedsTableShell resetKey={resetKey}>
        <Suspense key={resetKey} fallback={<TableRowsSkeleton columns={6} />}>
          {tableBody}
        </Suspense>
      </FeedsTableShell>

      <Suspense key={resetKey} fallback={<PaginationPlaceholder />}>
        {pagination}
      </Suspense>
    </>
  );
}
