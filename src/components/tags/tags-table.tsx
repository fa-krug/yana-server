"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { useEffect } from "react";
import { toast } from "sonner";

import { BulkActionBar, type BulkAction } from "@/components/crud/bulk-action-bar";
import { DataTableBody, DataTableHeader, type Column } from "@/components/crud/data-table";
import { ListSelectionProvider, useListSelection } from "@/components/crud/list-selection";
import { Pagination } from "@/components/crud/pagination";
import { Table } from "@/components/ui/table";
import { attempt } from "@/lib/tags/result";
import { deleteTags } from "@/lib/tags/actions";
import type { TagListRow } from "@/lib/tags/queries";
import { TagColorDot } from "./tag-color-dot";
import { useTagUsage } from "./use-tag-usage";

/** Shared between the header (rendered immediately) and the body (rendered once rows arrive). */
function useTagsColumns(): Column<TagListRow>[] {
  const t = useTranslations("tags");
  const format = useFormatter();

  return [
    {
      key: "name",
      header: t("columns.name"),
      sortable: true,
      cell: (row) => (
        <Link
          href={`/tags/${row.id}`}
          className="inline-flex items-center gap-2 font-medium hover:underline"
        >
          <TagColorDot color={row.color} />
          {row.name}
        </Link>
      ),
    },
    {
      key: "createdAt",
      header: t("columns.created"),
      sortable: true,
      cell: (row) => format.dateTime(row.createdAt, { dateStyle: "medium" }),
    },
  ];
}

/**
 * Chrome: the bulk action bar and the table's header row, with no dependency on
 * `rows` -- a page renders this outside its `<Suspense>` boundary so it never
 * disappears while the rows themselves are loading. `children` is the
 * `<Suspense>`-wrapped body (a `<TagsTableBody>` once resolved, a
 * `<TableRowsSkeleton>` fallback until then).
 *
 * **Never give this a `key` that changes with the list's params** -- pass
 * `resetKey` instead. See the doc comment on `<ListSelectionProvider>` for why.
 */
export function TagsTableShell({
  children,
  resetKey,
}: {
  children: React.ReactNode;
  resetKey?: string;
}) {
  return (
    <ListSelectionProvider resetKey={resetKey}>
      <TagsTableChrome>{children}</TagsTableChrome>
    </ListSelectionProvider>
  );
}

function TagsTableChrome({ children }: { children: React.ReactNode }) {
  const t = useTranslations("tags");
  const router = useRouter();
  const { selected, onSelectedChange, pageIds } = useListSelection();
  const usage = useTagUsage(selected.map(Number));
  const columns = useTagsColumns();

  async function removeSelected(): Promise<boolean> {
    if (selected.length === 0) return false;

    const result = await attempt(() => deleteTags(selected.map(Number)));

    if (!result.ok) {
      toast.error(result.errorKey ? t(result.errorKey) : t("saveFailed"));
      return false;
    }

    onSelectedChange([]);
    router.refresh();

    if (result.deleted === 0) toast.info(t("deletedNone"));
    else toast.success(t("deleted", { count: result.deleted }));
    return true;
  }

  const count = selected.length;
  const actions: BulkAction[] = [
    {
      key: "delete",
      label: t("bulkDelete"),
      destructive: true,
      confirm: {
        title: t("bulkDeleteTitle", { count }),
        description: usage
          ? usage.feeds > 0
            ? t("bulkDeleteDescription", { count, feeds: usage.feeds })
            : t("bulkDeleteDescriptionZero")
          : t("bulkDeleteDescriptionPending", { count }),
        confirmLabel: t("deleteConfirm"),
      },
      run: removeSelected,
    },
  ];

  return (
    <div className="space-y-4">
      <BulkActionBar count={count} actions={actions} onClear={() => onSelectedChange([])} />
      <Table>
        <DataTableHeader
          columns={columns}
          pageIds={pageIds}
          selected={selected}
          onSelectedChange={onSelectedChange}
        />
        {children}
      </Table>
    </div>
  );
}

/** The data-dependent half: must render inside a `<TagsTableShell>`. */
export function TagsTableBody({ rows }: { rows: TagListRow[] }) {
  const columns = useTagsColumns();
  const { selected, onSelectedChange, setPageIds } = useListSelection();
  const rowId = (row: TagListRow) => String(row.id);

  // Reports this page's ids up to the shell once real rows exist, which is
  // what lets the header's select-all checkbox (rendered before this ever
  // mounts) become accurate the moment it does.
  useEffect(() => {
    setPageIds(rows.map(rowId));
  }, [rows, setPageIds]);

  return (
    <DataTableBody
      rows={rows}
      columns={columns}
      rowId={rowId}
      selected={selected}
      onSelectedChange={onSelectedChange}
    />
  );
}

/**
 * The all-at-once form: everything above, composed for a caller with no
 * reason to split header from body across a `<Suspense>` boundary.
 */
export function TagsTable({
  rows,
  page,
  pageSize,
  total,
}: {
  rows: TagListRow[];
  page: number;
  pageSize: number;
  total: number;
}) {
  return (
    <div className="space-y-4">
      <TagsTableShell>
        <TagsTableBody rows={rows} />
      </TagsTableShell>
      <Pagination page={page} pageSize={pageSize} total={total} />
    </div>
  );
}
