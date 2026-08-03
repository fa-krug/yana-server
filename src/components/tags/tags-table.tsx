"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";

import { BulkActionBar, type BulkAction } from "@/components/crud/bulk-action-bar";
import { DataTable, type Column } from "@/components/crud/data-table";
import { Pagination } from "@/components/crud/pagination";
import { attempt } from "@/lib/tags/result";
import { deleteTags } from "@/lib/tags/actions";
import type { TagListRow } from "@/lib/tags/queries";
import { TagColorDot } from "./tag-color-dot";
import { useTagUsage } from "./use-tag-usage";

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
  const t = useTranslations("tags");
  const format = useFormatter();
  const router = useRouter();
  const [selected, setSelected] = useState<number[]>([]);
  const usage = useTagUsage(selected);

  const columns: Column<TagListRow>[] = [
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

  async function removeSelected(): Promise<boolean> {
    if (selected.length === 0) return false;

    const result = await attempt(() => deleteTags(selected));

    if (!result.ok) {
      toast.error(result.errorKey ? t(result.errorKey) : t("saveFailed"));
      return false;
    }

    setSelected([]);
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
      <BulkActionBar count={count} actions={actions} onClear={() => setSelected([])} />
      <DataTable
        rows={rows}
        columns={columns}
        rowId={(row) => String(row.id)}
        selected={selected.map(String)}
        onSelectedChange={(ids) => setSelected(ids.map(Number))}
      />
      <Pagination page={page} pageSize={pageSize} total={total} />
    </div>
  );
}
