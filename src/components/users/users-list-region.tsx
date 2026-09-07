"use client";

import { Suspense, type ReactNode } from "react";

import { PaginationPlaceholder } from "@/components/crud/pagination";
import { useListParams } from "@/components/crud/use-list-params";
import { TableRowsSkeleton } from "@/components/data-skeleton";
import { UsersTableShell } from "@/components/users/users-table";

/**
 * The two `<Suspense>` boundaries around the users table body and pagination,
 * each reset by the current list params -- previously computed in `UsersPage`
 * itself via `JSON.stringify(parseListParams(await searchParams))`.
 *
 * `UsersPage` cannot await `searchParams` any more (see its own doc comment),
 * so it cannot compute that key synchronously either. Reading it here instead,
 * via `useListParams()` -- the same `parseListParams()` the server side uses,
 * just sourced from the URL client-side -- gives an identical key without the
 * page body awaiting anything. This is `FeedsListRegion`'s shape exactly; see
 * that file for the transition/`resetKey` reasoning it documents.
 *
 * `tableBody`/`pagination` are Server Component elements (`<UsersBody>`,
 * `<UsersPagination>`) that `UsersPage` constructs and hands down as props --
 * elements, never functions, so the Server-to-Client function-prop tripwire
 * (`src/app/server-component-props.test.ts`) stays satisfied.
 */
export function UsersListRegion({
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
      <UsersTableShell resetKey={resetKey}>
        <Suspense key={resetKey} fallback={<TableRowsSkeleton columns={6} />}>
          {tableBody}
        </Suspense>
      </UsersTableShell>

      <Suspense key={resetKey} fallback={<PaginationPlaceholder />}>
        {pagination}
      </Suspense>
    </>
  );
}
