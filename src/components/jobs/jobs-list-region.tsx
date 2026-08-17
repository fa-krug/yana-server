"use client";

import { Suspense, use, type ReactNode } from "react";

import { PaginationPlaceholder } from "@/components/crud/pagination";
import { useListParams } from "@/components/crud/use-list-params";
import { TableRowsSkeleton } from "@/components/data-skeleton";
import { JobsTableShell } from "@/components/jobs/jobs-table";

/**
 * The jobs table shell and the pagination row, plus the two `<Suspense>`
 * boundaries around them -- `FeedsListRegion`'s shape, with one addition
 * `/feeds` does not need: `showOwner`.
 *
 * Only an admin sees jobs across every user, so only an admin gets the column
 * that says whose -- and that decision is the *same* fresh-role read
 * `listJobsForCurrentUser()` (`src/lib/jobs/queries.ts`) makes to scope the
 * rows, handed here as a promise rather than awaited in `JobsPage`'s body.
 *
 * **The promise resolves to a plain `boolean`, never the `User` row
 * `requireUserFreshRole()` returns.** React serializes whatever a promise
 * handed to a Client Component *resolves to*, not its declared type, so a
 * `Promise<User>` typed as `Promise<boolean>` would still put email, role and
 * the ban columns into the page's flight payload. The narrowing happens on the
 * server, inside `listJobsForCurrentUser()`, which returns `showOwner` as part
 * of its own result -- the same rule `getSettingsSummary()` and
 * `<SectionCardsGate>` follow.
 *
 * The pending branch renders the **non-admin** shape (`showOwner={false}`,
 * five skeleton columns), never a chrome-less skeleton: the bulk-action bar,
 * the real header row and the reserved pagination height are all known before
 * the role is. For an admin the owner column simply appears a moment later,
 * which is the same "harmless partial mismatch" the deleted `loading.tsx`
 * documented -- except the chrome around it no longer disappears first. It is
 * not itself a role read: `requireUserFreshRole()` is called exactly once, on
 * the server, and this never falls back to a cached role.
 */
export function JobsListRegion({
  showOwner,
  tableBody,
  pagination,
}: {
  showOwner: Promise<boolean>;
  tableBody: ReactNode;
  pagination: ReactNode;
}) {
  const { params } = useListParams();
  const resetKey = JSON.stringify(params);

  return (
    <Suspense
      fallback={
        <JobsRegion
          showOwner={false}
          resetKey={resetKey}
          tableBody={<TableRowsSkeleton columns={5} />}
          pagination={<PaginationPlaceholder />}
        />
      }
    >
      <JobsRegionResolved
        promise={showOwner}
        resetKey={resetKey}
        tableBody={tableBody}
        pagination={pagination}
      />
    </Suspense>
  );
}

/** Calls use(); suspends until the role resolves; renders the real region. */
function JobsRegionResolved({
  promise,
  resetKey,
  tableBody,
  pagination,
}: {
  promise: Promise<boolean>;
  resetKey: string;
  tableBody: ReactNode;
  pagination: ReactNode;
}) {
  const showOwner = use(promise);

  return (
    <JobsRegion
      showOwner={showOwner}
      resetKey={resetKey}
      tableBody={
        <Suspense key={resetKey} fallback={<TableRowsSkeleton columns={showOwner ? 6 : 5} />}>
          {tableBody}
        </Suspense>
      }
      pagination={
        <Suspense key={resetKey} fallback={<PaginationPlaceholder />}>
          {pagination}
        </Suspense>
      }
    />
  );
}

/**
 * The layout both branches share, so the pending one cannot drift from the
 * resolved one the way the hand-mirrored `loading.tsx` did.
 *
 * See `src/app/(app)/tags/page.tsx` for why the shell takes `resetKey` rather
 * than a `key`, and why only the inner Suspense is keyed.
 */
function JobsRegion({
  showOwner,
  resetKey,
  tableBody,
  pagination,
}: {
  showOwner: boolean;
  resetKey: string;
  tableBody: ReactNode;
  pagination: ReactNode;
}) {
  return (
    <>
      <JobsTableShell resetKey={resetKey} showOwner={showOwner}>
        {tableBody}
      </JobsTableShell>
      {pagination}
    </>
  );
}
