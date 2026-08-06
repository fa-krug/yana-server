"use client";

import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import type * as React from "react";

import { toggleAll, toggleRow } from "@/components/crud/selection";
import { useListParams } from "@/components/crud/use-list-params";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { buildListHref, type ListParams } from "@/lib/crud/params";

export type Column<T> = {
  /** Both the React key and the value `?sort=` carries for a sortable column. */
  key: string;
  /** Already translated by the caller -- the kit cannot know a caller's columns. */
  header: string;
  cell: (row: T) => React.ReactNode;
  sortable?: boolean;
  /**
   * Applied to both the header and body cell -- a caller's escape hatch for
   * hiding a lower-priority column below a breakpoint (`"hidden sm:table-cell"`)
   * rather than letting every column force the table into a horizontal scroll
   * on a phone. Optional: a column with none behaves exactly as before.
   */
  className?: string;
};

/**
 * The header row alone -- everything `<DataTable>` renders above `<TableBody>`.
 *
 * Split out so a list page can render it **outside** the `<Suspense>` boundary
 * that gates the rows: the labels, the sort links and the column set come from
 * `columns` and the URL alone, never from `rows`, so there is no reason the
 * header has to wait on the query that fills the body. `pageIds` is the one
 * piece that *is* data-shaped (it decides the select-all checkbox's state) --
 * a caller rendering this before any row has loaded passes `[]`, which reads as
 * "nothing to select yet" rather than a wrong answer (see
 * `<ListSelectionProvider>` in `./list-selection`, which is what makes a header
 * and a body rendered on either side of a Suspense boundary agree about it).
 */
export function DataTableHeader<T>({
  columns,
  pageIds,
  selected,
  onSelectedChange,
}: {
  columns: Column<T>[];
  pageIds: string[];
  selected: string[];
  onSelectedChange: (ids: string[]) => void;
}) {
  const t = useTranslations("crud");
  const { pathname, params } = useListParams();

  // A Set, because both this count and every row below ask the same question;
  // `pageSize` reaches 100 and phase 10's articles will use all of it.
  const selectedIds = new Set(selected);
  const selectedHere = pageIds.filter((id) => selectedIds.has(id)).length;
  // Three states, not two: "some" must be visibly distinct from "all", or the
  // operator cannot tell a half-selected page from a full one before pressing
  // a bulk action.
  const allSelected = pageIds.length > 0 && selectedHere === pageIds.length;
  const someSelected = selectedHere > 0 && !allSelected;

  return (
    <TableHeader>
      <TableRow>
        <TableHead className="w-8">
          <Checkbox
            aria-label={t("selectAll")}
            checked={allSelected}
            indeterminate={someSelected}
            disabled={pageIds.length === 0}
            onCheckedChange={() => onSelectedChange(toggleAll(pageIds, selected))}
          />
        </TableHead>
        {columns.map((column) => (
          <TableHead
            key={column.key}
            className={column.className}
            // Announced by screen readers, and the only machine-readable
            // record of which column the list is ordered by. Only on columns
            // that can actually be sorted: `aria-sort="none"` on a fixed
            // column advertises a control that is not there.
            aria-sort={
              !column.sortable
                ? undefined
                : params.sort !== column.key
                  ? "none"
                  : params.dir === "desc"
                    ? "descending"
                    : "ascending"
            }
          >
            {column.sortable ? (
              <SortLink
                header={column.header}
                sortKey={column.key}
                pathname={pathname}
                params={params}
              />
            ) : (
              column.header
            )}
          </TableHead>
        ))}
      </TableRow>
    </TableHeader>
  );
}

/**
 * The body alone -- the part of `<DataTable>` that actually needs `rows`.
 *
 * Split out for the same reason as `<DataTableHeader>`: a list page's
 * `<Suspense>` fallback can be this component's own row-shaped skeleton
 * (`<TableRowsSkeleton>` in `@/components/data-skeleton`) instead of a fallback
 * that replaces the whole table, header included.
 */
export function DataTableBody<T>({
  rows,
  columns,
  rowId,
  selected,
  onSelectedChange,
}: {
  rows: T[];
  columns: Column<T>[];
  rowId: (row: T) => string;
  selected: string[];
  onSelectedChange: (ids: string[]) => void;
}) {
  const t = useTranslations("crud");
  const selectedIds = new Set(selected);

  return (
    <TableBody>
      {rows.length === 0 ? (
        <TableRow>
          {/* +1 for the checkbox column. A search that matches nothing must
              say so; an empty <tbody> reads as a broken page. */}
          <TableCell
            colSpan={columns.length + 1}
            className="py-8 text-center text-muted-foreground"
          >
            {t("empty")}
          </TableCell>
        </TableRow>
      ) : (
        rows.map((row) => {
          const id = rowId(row);
          const isSelected = selectedIds.has(id);
          return (
            <TableRow key={id} data-state={isSelected ? "selected" : undefined}>
              <TableCell>
                <Checkbox
                  aria-label={t("selectRow")}
                  checked={isSelected}
                  onCheckedChange={() => onSelectedChange(toggleRow(id, selected))}
                />
              </TableCell>
              {columns.map((column) => (
                <TableCell key={column.key} className={column.className}>
                  {column.cell(row)}
                </TableCell>
              ))}
            </TableRow>
          );
        })
      )}
    </TableBody>
  );
}

/**
 * The list table every CRUD page in phases 5, 8, 9 and 10 renders.
 *
 * Three decisions are load-bearing:
 *
 * - **Select-all covers the current page and nothing else.** See `toggleAll()`
 *   in `./selection`, where the rule and its tests live.
 * - **`rowId` is a prop, never `row.id`.** Tags and articles key differently,
 *   and an integer id becomes `String(row.id)` at the call site rather than a
 *   second selection type here.
 * - **Sorting is a navigation, not state.** A sortable header is a `<Link>`
 *   built with `buildListHref`, so a sorted list is linkable, survives a
 *   reload, and reaches the server -- which is where the ordering is actually
 *   applied.
 *
 * A composition of `<DataTableHeader>` and `<DataTableBody>` -- kept as one
 * component for a caller that has no reason to split the two across a
 * `<Suspense>` boundary (every list page under `src/app/(app)` does; see
 * `./list-selection`).
 */
export function DataTable<T>({
  rows,
  columns,
  rowId,
  selected,
  onSelectedChange,
}: {
  rows: T[];
  columns: Column<T>[];
  rowId: (row: T) => string;
  selected: string[];
  onSelectedChange: (ids: string[]) => void;
}) {
  return (
    <Table>
      <DataTableHeader
        columns={columns}
        pageIds={rows.map(rowId)}
        selected={selected}
        onSelectedChange={onSelectedChange}
      />
      <DataTableBody
        rows={rows}
        columns={columns}
        rowId={rowId}
        selected={selected}
        onSelectedChange={onSelectedChange}
      />
    </Table>
  );
}

/**
 * A sortable header.
 *
 * Clicking the column the list is already sorted by flips the direction;
 * clicking any other column starts it ascending. `buildListHref` carries the
 * search and the filters along -- re-ordering a result set does not change
 * which set it is, so it deliberately does not reset the page either.
 *
 * Declared at module level rather than inside `DataTable`, and not generic: a
 * component defined in a render body is a *new type* on every render, which
 * remounts its subtree each time. It needs no row type -- only the header text
 * and the sort key.
 */
function SortLink({
  header,
  sortKey,
  pathname,
  params,
}: {
  header: string;
  sortKey: string;
  pathname: string;
  params: ListParams;
}) {
  const active = params.sort === sortKey;
  const dir = active && params.dir === "asc" ? "desc" : "asc";
  const Icon = !active ? ChevronsUpDown : params.dir === "desc" ? ArrowDown : ArrowUp;

  return (
    <Link
      href={buildListHref(pathname, params, { sort: sortKey, dir })}
      className="inline-flex items-center gap-1 hover:text-foreground/80"
    >
      {header}
      <Icon
        aria-hidden="true"
        className={active ? "size-3.5" : "size-3.5 text-muted-foreground/50"}
      />
    </Link>
  );
}
