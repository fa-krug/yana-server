import { Skeleton } from "@/components/ui/skeleton";
import { TableBody, TableCell, TableRow } from "@/components/ui/table";

/**
 * Real `<tbody>`/`<tr>`/`<td>` markup, unlike {@link TableSkeleton} below --
 * this one is meant to sit *inside* a real `<table>`, as the `<Suspense>`
 * fallback for `<DataTableBody>` (`@/components/crud/data-table`) while the
 * real `<DataTableHeader>` above it has already rendered. A `<div>`-based
 * skeleton there would be invalid HTML after a `<thead>` and browsers silently
 * hoist it out of the table, which is exactly the "chrome disappears while
 * loading" bug this component exists to avoid.
 *
 * `columns` is the caller's data-column count, not counting the leading
 * checkbox column every `<DataTable>` adds -- this adds one more skeleton cell
 * to line up underneath it.
 */
export function TableRowsSkeleton({ rows = 3, columns = 4 }: { rows?: number; columns?: number }) {
  return (
    <TableBody aria-busy="true" aria-live="polite">
      {Array.from({ length: rows }, (_, row) => (
        <TableRow key={row}>
          <TableCell>
            <Skeleton className="size-4" />
          </TableCell>
          {Array.from({ length: columns }, (_, column) => (
            <TableCell key={column}>
              <Skeleton className="h-4 w-full" />
            </TableCell>
          ))}
        </TableRow>
      ))}
    </TableBody>
  );
}

/**
 * A `<div>`-based grid of bars, for the one remaining place where a *shape*
 * rather than a value is unknown and no real control can stand in for it: the
 * article detail route's "Content" section (`(app)/articles/[id]/page.tsx` and
 * its `loading.tsx`), whose block tree has no form to mirror.
 *
 * **This is not a general-purpose page fallback.** Until the 2026-08-16
 * streaming-controls migration it was also what `(app)/loading.tsx` rendered
 * for every route with no nearer `loading.tsx`, which is how `/feeds/new`
 * showed a table shape while loading a form. Every route now renders its real
 * chassis in a `pending` state instead -- see CLAUDE.md's streaming-pattern
 * bullet before reaching for this.
 */
export function TableSkeleton({ rows = 3, columns = 4 }: { rows?: number; columns?: number }) {
  return (
    <div className="space-y-2" aria-busy="true" aria-live="polite">
      {Array.from({ length: rows }, (_, row) => (
        <div key={row} className="flex gap-2">
          {Array.from({ length: columns }, (_, column) => (
            <Skeleton key={column} className="h-9 flex-1" />
          ))}
        </div>
      ))}
    </div>
  );
}
