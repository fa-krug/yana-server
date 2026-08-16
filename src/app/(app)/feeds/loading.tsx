import { PaginationPlaceholder } from "@/components/crud/pagination";
import { TableRowsSkeleton } from "@/components/data-skeleton";
import { FeedsChrome } from "@/components/feeds/feeds-chrome";
import { FeedsTableShell } from "@/components/feeds/feeds-table";

/**
 * The route's own fallback, replacing `(app)/loading.tsx`'s generic
 * `<TableSkeleton>` for this segment specifically. Without this file, an
 * initial navigation to `/feeds` shows that unrelated fallback for however
 * long `FeedsPage` takes to resolve -- title-less, header-less, nothing like
 * the table it precedes -- because the whole async page function (including
 * its synchronous chrome) suspends as one unit until it returns.
 *
 * The header and search/filter bar are `<FeedsChrome>`, the same component
 * `FeedsPage` itself renders -- see that component's doc comment for why this
 * file used to drift from it (a missing Export OPML link, a missing
 * `<ImportOpmlButton>`, and no filters at all, despite a comment here once
 * claiming otherwise). Sharing one component makes that drift impossible
 * rather than merely documented against.
 *
 * `<FeedsTableShell>` (bulk-action bar + real header row, no dependency on
 * `rows`) is unchanged from before, with `<TableRowsSkeleton>` standing in for
 * the body it wraps in a `<Suspense>` there, and `<PaginationPlaceholder>`
 * reserves the pagination row's height -- see its doc comment for why.
 *
 * `FeedsChrome` is called and awaited directly (`{await FeedsChrome()}`)
 * rather than rendered as `<FeedsChrome />`: it is an async function, and only
 * Server Components may be async in a tree React itself renders -- a
 * testing-library render (used by this file's own test) goes through
 * `ReactDOM`, not the RSC renderer, so an unresolved async element throws
 * there. Calling and awaiting it first hands both `page.tsx` and this file a
 * plain, already-resolved element tree, the same technique
 * `src/app/(app)/layout.tsx` uses for itself (see CLAUDE.md).
 */
export default async function Loading() {
  return (
    <div className="space-y-4">
      {await FeedsChrome()}

      <FeedsTableShell>
        <TableRowsSkeleton columns={6} />
      </FeedsTableShell>

      <PaginationPlaceholder />
    </div>
  );
}
